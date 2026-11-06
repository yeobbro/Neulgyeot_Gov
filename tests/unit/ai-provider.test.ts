import assert from "node:assert/strict";
import { test } from "node:test";
import type { DraftContent, Fact } from "../../lib/domain/ai-draft";
import { classifyFact, hasIdentifierPattern, selectSendableFacts } from "../../lib/server/ai/fact-policy";
import { AIIntelligenceProvider, CircuitBreaker, composeDraft, providerFromEnv, sentenceEvidenceProblems } from "../../lib/server/ai/provider";

const F = (id: string, text: string, sourceType: string, field: string): Fact => ({ id, text, sourceType, sourceId: "src_1", field });
const FACTS: Fact[] = [
  F("F1", "퇴원 예정일 2026-11-20", "referral_payload", "discharge.plannedDate"),
  F("F2", "퇴원 후 동거 형태: 독거", "referral_payload", "livingNeeds.livingArrangement"),
  F("F3", "주거 장애요인: 계단, 욕실 접근성", "referral_payload", "livingNeeds.barriers"),
  F("F4", "퇴원 후 동거 형태: 아들 김가상과 동거 예정", "referral_payload", "livingNeeds.livingArrangement"),
  F("F5", "병원 사회복지사 소견: 아들 010-2222-3333", "referral_payload", "livingNeeds.socialWorkerNote"),
  F("F6", "식사·영양: 끼니를 자주 거름", "assessment_item", "nutrition"),
  F("F7", "보완 요청 항목: 보호자 연락처 확인", "incoming_referral", "missing_items"),
  F("F8", "연계 접수 상태: UNDER_REVIEW", "incoming_referral", "status"),
  F("F9", "가구 형태: 독거, 인근 거주 자녀 주 1회 방문", "care_recipient", "household_type"),
  F("F10", "지원계획(DRAFT) 포함 서비스: 식사 지원 주 3회, 방문간호 주 1회", "support_plan", "items"),
  F("F11", "지원계획(DRAFT) 포함 서비스: 식사 지원 화요일 오후 김가상 담당", "support_plan", "items"),
  F("F12", "알 수 없는 필드", "new_source", "x"),
];
const RULE: DraftContent = {
  sections: [
    { title: "현재 확인된 주요 사실", sentences: [{ text: "퇴원 예정일이 전달되었습니다.", factIds: ["F1"] }] },
    { title: "돌봄 욕구 및 요청 서비스", sentences: [{ text: "주거 장애요인이 보고되었습니다.", factIds: ["F3"] }] },
  ],
};

/* ------------------------------------------------------------------ fact policy */
test("fact policy: default-deny, value-based vocabulary, identifier guard", () => {
  const { sendable, excluded } = selectSendableFacts(FACTS);
  assert.deepEqual(sendable.map((f) => f.id), ["F1", "F2", "F3", "F8", "F10"]);
  const why = Object.fromEntries(excluded.map((e) => [e.id, e.reason]));
  assert.deepEqual(why, {
    F4: "vocab_mismatch", // allowlisted field, but the value is not a known label
    F5: "never_send", // social worker note: excluded before any other rule, not overridable
    F6: "free_text", F7: "free_text",
    F9: "vocab_mismatch", // real seed value of household_type
    F11: "vocab_mismatch", // plan item with free-text frequency
    F12: "not_allowlisted",
  });
  assert.equal(classifyFact(FACTS[5]), "free_text");
  // a future "allow free text" setting can never release the social worker note …
  assert.equal(selectSendableFacts([FACTS[4]], { allowFreeText: true }).excluded[0].reason, "never_send");
  // … and other free text with identifiers is still blocked by the identifier guard
  assert.equal(selectSendableFacts([F("F20", "보완 요청 항목: 보호자 010-1234-5678 확인", "incoming_referral", "missing_items")], { allowFreeText: true }).excluded[0].reason, "identifier_pattern");
  for (const s of ["010-1234-5678", "800101-1234567", "a@b.kr", "1234 5678 9012 3456", "환자번호 12345678"]) assert.ok(hasIdentifierPattern(s), s);
  for (const s of ["퇴원 예정일 2026-11-20", "SR-2026-0031 방문간호: 회신 대기"]) assert.ok(!hasIdentifierPattern(s), s);
});

test("evidence check: numbers must come from cited facts; non-Korean rejected", () => {
  assert.deepEqual(sentenceEvidenceProblems("퇴원 예정일은 2026년 11월 20일입니다.", [FACTS[0]]), []);
  assert.match(sentenceEvidenceProblems("퇴원 예정일은 12월 1일입니다.", [FACTS[0]])[0], /근거에 없는 수치/);
  assert.match(sentenceEvidenceProblems("出院日期已确认。", [FACTS[0]])[0], /한국어가 아닌/);
});

/* ------------------------------------------------------------------ client */
type Step = () => Response | Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const okBody = (sections: unknown, extra: Record<string, unknown> = {}) => ({
  request_id: "req_0123456789abcdef0123", trace_id: "trc_x", status: "ok", reason: null, engine: "llamacpp:test", model: "qwen3-4b-test",
  prompt_version: "gov-sectioned-2026-11-06.1", sections, requires_human_review: true, ...extra,
});
function mock(steps: Step[]) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const s = steps.shift();
    if (!s) throw new TypeError("fetch failed");
    return s();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const provider = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof AIIntelligenceProvider>[0]> = {}) =>
  new AIIntelligenceProvider({ baseUrl: "http://127.0.0.1:8810", tokenForTenant: (t) => ({ tn_gaon: "tok-gaon" } as Record<string, string>)[t], timeoutMs: 300, fetchImpl: f, ...extra });
const compose = (p: AIIntelligenceProvider | null, tenantId = "tn_gaon") => composeDraft({ provider: p, tenantId, kind: "referral_summary", facts: FACTS, ruleDraft: RULE, traceId: "trc_test_000001" });

test("request: tenant token + tenant header + trace id, only allowlisted facts, no free text, strict schema", async () => {
  const m = mock([() => json(200, okBody([{ title: "현재 확인된 주요 사실", sentences: [{ text: "퇴원 예정일은 2026년 11월 20일입니다.", source_ids: ["F1"] }] }]))]);
  const r = await compose(provider(m.f));
  assert.equal(r.engine, "hybrid");
  assert.deepEqual(r.sectionEngines, ["ai-intelligence", "rules"]);
  assert.equal(r.aiRequestId, "req_0123456789abcdef0123");
  assert.equal(r.model, "qwen3-4b-test");
  assert.equal(r.promptVersion, "gov-sectioned-2026-11-06.1");
  const c = m.calls[0];
  assert.equal(c.url, "http://127.0.0.1:8810/ai/v1/summarize");
  assert.equal(c.headers.authorization, "Bearer tok-gaon");
  assert.equal(c.headers["x-tenant-id"], "tn_gaon");
  assert.equal(c.headers["x-request-id"], "trc_test_000001");
  assert.deepEqual(c.body.records.map((r: any) => r.id), ["F1", "F2", "F3", "F8", "F10"]);
  assert.ok(!JSON.stringify(c.body).includes("010-2222") && !JSON.stringify(c.body).includes("김가상") && !JSON.stringify(c.body).includes("끼니"));
  assert.equal(c.body.allow_free_text, false);
  assert.deepEqual(c.body.sections, RULE.sections.map((s) => s.title));
});

test("a tenant without its own token is never served with another tenant's token", async () => {
  const m = mock([]);
  const r = await compose(provider(m.f), "tn_nuri");
  assert.equal(r.fallbackReason, "no_tenant_token");
  assert.equal(m.calls.length, 0);
  assert.deepEqual(r.content, RULE);
});

test("AI output is re-verified: ids not sent, unknown ids, forbidden phrases, extra numbers, non-Korean, injected sections", async () => {
  const m = mock([() => json(200, okBody([
    { title: "현재 확인된 주요 사실", sentences: [
      { text: "퇴원 예정일은 2026년 11월 20일입니다.", source_ids: ["F1"] },
      { text: "사회복지사 소견이 있습니다.", source_ids: ["F5"] }, // real fact, but it was NOT sent (free text)
      { text: "근거 없는 문장입니다.", source_ids: ["F99"] },
      { text: "긴급한 개입이 필요합니다.", source_ids: ["F8"] },
      { text: "퇴원 예정일은 12월 1일입니다.", source_ids: ["F1"] },
      { text: "出院日期已确认。", source_ids: ["F1"] },
    ] },
    { title: "주입된 섹션", sentences: [{ text: "모든 대상자 목록", source_ids: ["F1"] }] },
  ]))]);
  const r = await compose(provider(m.f));
  assert.deepEqual(r.content.sections[0].sentences.map((s) => s.text), ["퇴원 예정일은 2026년 11월 20일입니다."]);
  assert.equal(r.rejected.length, 5, r.rejected.join(" | "));
  assert.ok(r.rejected.some((x) => x.includes("요청에 없던 근거 F5")));
  assert.deepEqual(r.content.sections.map((s) => s.title), RULE.sections.map((s) => s.title));
});

test("malformed or policy-violating responses are treated as no result", async () => {
  for (const body of [{ hello: "world" }, okBody([], { requires_human_review: false }), okBody([{ title: "x", sentences: [{ text: "a", source_ids: ["F1"] }] }])]) {
    const r = await compose(provider(mock([() => json(200, body)]).f));
    assert.equal(r.engine, "rules");
    assert.ok(["invalid_response", "all_ai_sentences_rejected"].includes(r.fallbackReason!), r.fallbackReason!);
  }
  const noResult = await compose(provider(mock([() => json(200, okBody([], { status: "no_result", reason: "timeout" }))]).f));
  assert.equal(noResult.fallbackReason, "timeout");
});

test("retry policy: network error retried once; timeout and 4xx never retried; 503 retried after Retry-After", async () => {
  let m = mock([() => { throw new TypeError("fetch failed"); }, () => json(200, okBody([{ title: "현재 확인된 주요 사실", sentences: [{ text: "퇴원 예정일 2026-11-20입니다.", source_ids: ["F1"] }] }]))]);
  assert.equal((await compose(provider(m.f))).engine, "hybrid");
  assert.equal(m.calls.length, 2);
  m = mock([() => new Promise<Response>((_, rej) => setTimeout(() => rej(Object.assign(new Error("t"), { name: "TimeoutError" })), 5))]);
  assert.equal((await compose(provider(m.f))).fallbackReason, "timeout");
  assert.equal(m.calls.length, 1);
  m = mock([() => json(403, { error: { code: "tenant_mismatch", message: "x" } })]);
  assert.equal((await compose(provider(m.f))).fallbackReason, "tenant_mismatch");
  assert.equal(m.calls.length, 1);
  m = mock([() => json(503, { error: { code: "busy", message: "x" } }, { "retry-after": "0" }), () => json(200, okBody([{ title: "현재 확인된 주요 사실", sentences: [{ text: "퇴원 예정일 2026-11-20입니다.", source_ids: ["F1"] }] }]))]);
  assert.equal((await compose(provider(m.f))).engine, "hybrid");
  assert.equal(m.calls.length, 2);
  // a 503 that persists after the in-request retry is reported as `unavailable` (the only HTTP status the job queue reschedules)
  m = mock([() => json(503, {}, { "retry-after": "0" }), () => json(503, {}, { "retry-after": "0" })]);
  assert.equal((await compose(provider(m.f))).fallbackReason, "unavailable");
  assert.equal(m.calls.length, 2);
  m = mock([() => json(500, {})]);
  assert.equal((await compose(provider(m.f))).fallbackReason, "server_error");
  assert.equal(m.calls.length, 1, "500 is not retried");
});

test("circuit breaker: opens after 3 failures, no calls while open, one probe after cooldown", async () => {
  let now = 0;
  const m = mock(Array.from({ length: 10 }, () => () => json(500, {})));
  const p = provider(m.f, { breaker: new CircuitBreaker(3, 1000, () => now) });
  for (let i = 0; i < 3; i++) assert.equal((await compose(p)).fallbackReason, "server_error");
  assert.equal(p.breaker.state, "open");
  assert.equal((await compose(p)).fallbackReason, "circuit_open");
  assert.equal(m.calls.length, 3);
  now = 1500;
  await compose(p);
  assert.equal(m.calls.length, 4);
});

test("response trace id must match the request", async () => {
  const m = mock([() => json(200, okBody([]), { "x-request-id": "someone-else" })]);
  assert.equal((await compose(provider(m.f))).fallbackReason, "trace_mismatch");
});

test("predictions are accepted only when marked research_only", async () => {
  const p = provider(mock([() => json(200, { request_id: "r", model_id: "m", model_version: "0.1.0", score: 0.7, band: "high", use: "decision_support" })]).f);
  await assert.rejects(p.predictResearchOnly("tn_gaon", "community_care_gap_30d", "case_1", {}), /research_only/);
});

test("provider configuration: off by default, https required, tokens are per tenant", () => {
  assert.equal(providerFromEnv({}), null);
  assert.equal(providerFromEnv({ AI_PROVIDER: "ai_intelligence" }), null, "no URL → disabled");
  assert.throws(() => providerFromEnv({ AI_PROVIDER: "ai_intelligence", AI_INTELLIGENCE_URL: "http://ai.example.org" }), /https/);
  const p = providerFromEnv({ AI_PROVIDER: "ai_intelligence", AI_INTELLIGENCE_URL: "https://ai.internal", AI_INTELLIGENCE_TENANT_TOKENS: '{"tn_gaon":"t1"}' }) as AIIntelligenceProvider;
  assert.ok(p instanceof AIIntelligenceProvider);
  assert.throws(() => providerFromEnv({ AI_PROVIDER: "ai_intelligence", AI_INTELLIGENCE_URL: "https://ai.internal", AI_INTELLIGENCE_TENANT_TOKENS: "not json" }), /JSON/);
});

test("disabled provider → today's rule draft, unchanged", async () => {
  const r = await compose(null);
  assert.equal(r.fallbackReason, "ai_disabled");
  assert.deepEqual(r.content, RULE);
});
