import assert from "node:assert/strict";
import { test } from "node:test";
import type { DraftContent, Fact } from "../../lib/domain/ai-draft";
import { buildMessages, isLocalNetworkHost, LocalLLMProvider, localLLMFromEnv, parseModelOutput, stripCitationMarkers } from "../../lib/server/ai/local-llm";
import { composeDraft, providerFromEnv } from "../../lib/server/ai/provider";
import { selectSendableFacts } from "../../lib/server/ai/fact-policy";

const F = (id: string, text: string, sourceType: string, field: string): Fact => ({ id, text, sourceType, sourceId: "src_1", field });
const FACTS: Fact[] = [
  F("F1", "퇴원 예정일 2026-11-20", "referral_payload", "discharge.plannedDate"),
  F("F2", "퇴원 후 동거 형태: 독거", "referral_payload", "livingNeeds.livingArrangement"),
  F("F3", "주거 장애요인: 계단, 욕실 접근성", "referral_payload", "livingNeeds.barriers"),
  F("F5", "병원 사회복지사 소견: 아들 010-2222-3333", "referral_payload", "livingNeeds.socialWorkerNote"),
];
const RULE: DraftContent = {
  sections: [
    { title: "현재 확인된 주요 사실", sentences: [{ text: "퇴원 예정일이 전달되었습니다.", factIds: ["F1"] }] },
    { title: "돌봄 욕구 및 요청 서비스", sentences: [{ text: "주거 장애요인이 보고되었습니다.", factIds: ["F3"] }] },
  ],
};

/** fetch stub that answers like an OpenAI-compatible server and records what was sent */
function stub(content: string | null, opts: { status?: number; models?: string[] } = {}) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.endsWith("/models")) return new Response(JSON.stringify({ data: (opts.models ?? ["qwen2.5:7b"]).map((id) => ({ id })) }), { status: 200 });
    if ((opts.status ?? 200) !== 200) return new Response("{}", { status: opts.status });
    return new Response(JSON.stringify({ model: "qwen2.5:7b", choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const provider = (content: string | null, opts?: { status?: number; models?: string[] }) => {
  const s = stub(content, opts);
  return { p: new LocalLLMProvider({ baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b", fetchImpl: s.fetchImpl, maxRetries: 0 }), calls: s.calls };
};

test("config: off unless model set; https or local-network http only; dispatch via AI_PROVIDER", () => {
  assert.equal(localLLMFromEnv({}), null);
  assert.equal(providerFromEnv({ AI_PROVIDER: "local_llm" }), null, "no model → rules only");
  const p = providerFromEnv({ AI_PROVIDER: "local_llm", LOCAL_LLM_MODEL: "qwen2.5:7b" });
  assert.equal(p?.name, "local-llm", "defaults to Ollama on 127.0.0.1:11434");
  assert.ok(localLLMFromEnv({ LOCAL_LLM_MODEL: "m", LOCAL_LLM_BASE_URL: "http://192.168.0.20:11434" }));
  assert.ok(localLLMFromEnv({ LOCAL_LLM_MODEL: "m", LOCAL_LLM_BASE_URL: "https://llm.intra.example" }));
  assert.throws(() => localLLMFromEnv({ LOCAL_LLM_MODEL: "m", LOCAL_LLM_BASE_URL: "http://llm.example.com" }), /https/);
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "[::1]"]) assert.ok(isLocalNetworkHost(h), h);
  for (const h of ["8.8.8.8", "172.32.0.1", "example.com"]) assert.ok(!isLocalNetworkHost(h), h);
});

test("prompt: only the sendable facts are in the request; the social-worker note never is", async () => {
  const { sendable } = selectSendableFacts(FACTS);
  const msgs = buildMessages("referral_summary", RULE.sections.map((s) => s.title), sendable);
  const all = msgs.map((m) => m.content).join("\n");
  assert.ok(all.includes("F1: 퇴원 예정일 2026-11-20"));
  assert.ok(!all.includes("010-2222-3333") && !all.includes("F5"), "never_send fact excluded");
  assert.match(all, /자격.*판단하지 않습니다/);
});

test("parsing: fences, citation markers in text, source_ids alias, invalid JSON", () => {
  const s = parseModelOutput('```json\n{"sections":[{"title":"A","sentences":[{"text":"F1: 퇴원 예정일은 2026-11-20입니다.","factIds":["F1","F1"]},{"text":"독거 상태입니다 (F2)","source_ids":["F2"]}]}]}\n```');
  assert.equal(s[0].sentences[0].text, "퇴원 예정일은 2026-11-20입니다.");
  assert.deepEqual(s[0].sentences[0].factIds, ["F1"]);
  assert.deepEqual(s[0].sentences[1], { text: "독거 상태입니다", factIds: ["F2"] });
  assert.equal(stripCitationMarkers("[F3] 계단이 있습니다 [F3, F4]"), "계단이 있습니다");
  assert.throws(() => parseModelOutput("죄송합니다"), /JSON/);
  assert.throws(() => parseModelOutput('{"foo":1}'), /형식/);
});

test("composeDraft with the local provider: valid sentences kept, invented numbers/uncited ids rejected", async () => {
  const out = JSON.stringify({
    sections: [
      { title: "현재 확인된 주요 사실", sentences: [
        { text: "퇴원 예정일은 2026-11-20입니다.", factIds: ["F1"] },
        { text: "퇴원 후 독거 예정이며 주 3회 방문이 필요합니다.", factIds: ["F2"] }, // invented number
        { text: "보호자 연락처가 확인되었습니다.", factIds: ["F5"] }, // fact never sent
      ] },
      { title: "돌봄 욕구 및 요청 서비스", sentences: [{ text: "주거 장애요인으로 계단과 욕실 접근성이 보고되었습니다.", factIds: ["F3"] }] },
    ],
  });
  const { p, calls } = provider(out);
  const r = await composeDraft({ provider: p, tenantId: "tn_gaon", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "synthetic" });
  assert.equal(r.engine, "ai-intelligence");
  assert.equal(r.model, "local:qwen2.5:7b");
  assert.match(r.aiRequestId ?? "", /^req_[0-9a-f]{20}$/, "fits the ai_jobs.ai_request_id CHECK");
  assert.deepEqual(r.content.sections[0].sentences.map((x) => x.text), ["퇴원 예정일은 2026-11-20입니다."]);
  assert.equal(r.rejected.length, 2);
  assert.equal(calls[0].body.response_format.type, "json_object");
  assert.ok(!JSON.stringify(calls[0].body).includes("010-2222-3333"));
});

test("fallbacks: real data never sent; server down / bad output → rule draft", async () => {
  const { p, calls } = provider("{}");
  const real = await composeDraft({ provider: p, tenantId: "t", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "real" });
  assert.equal(real.fallbackReason, "real_data_blocked");
  assert.equal(calls.length, 0, "no network call for real data");
  const down = await composeDraft({ provider: provider(null, { status: 500 }).p, tenantId: "t", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "synthetic" });
  assert.equal(down.fallbackReason, "server_error");
  assert.equal(down.content, RULE);
  const junk = await composeDraft({ provider: provider("모르겠습니다").p, tenantId: "t", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "synthetic" });
  assert.equal(junk.fallbackReason, "invalid_json");
  const unknownModel = await composeDraft({ provider: provider(null, { status: 404 }).p, tenantId: "t", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "synthetic" });
  assert.equal(unknownModel.fallbackReason, "not_found");
});

test("health: reports whether the configured model is loaded", async () => {
  assert.deepEqual(await provider("{}").p.health(), { ok: true, llmAvailable: true });
  assert.equal((await provider("{}", { models: ["llama3"] }).p.health()).reason, "model_not_loaded");
});

/** Live check against a real local model: LOCAL_LLM_TEST_MODEL=qwen2.5:1.5b [LOCAL_LLM_BASE_URL=...] npm test */
test("live local LLM (skipped unless LOCAL_LLM_TEST_MODEL is set)", { skip: !process.env.LOCAL_LLM_TEST_MODEL }, async () => {
  const p = localLLMFromEnv({ LOCAL_LLM_MODEL: process.env.LOCAL_LLM_TEST_MODEL, LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL, LOCAL_LLM_TIMEOUT_MS: "300000" })!;
  assert.equal((await p.health()).ok, true);
  const r = await composeDraft({ provider: p, tenantId: "tn_gaon", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "synthetic" });
  console.log(JSON.stringify({ engine: r.engine, fallback: r.fallbackReason, rejected: r.rejected, sections: r.content.sections }, null, 1));
  // whatever the model says, only verified sentences can survive and the rule draft is the floor
  for (const s of r.content.sections) for (const x of s.sentences) assert.ok(x.factIds.every((id) => ["F1", "F2", "F3"].includes(id)));
});
