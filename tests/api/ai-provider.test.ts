/**
 * Provider flow against Gov's real seeded data (in-memory DB, synthetic). The AI service is mocked: no network.
 * Shows the intended two-phase flow: facts in a short tenant transaction, provider call OUTSIDE the transaction.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import { verifyDraft } from "../../lib/domain/ai-draft";
import { selectSendableFacts } from "../../lib/server/ai/fact-policy";
import { AIIntelligenceProvider, composeDraft } from "../../lib/server/ai/provider";
import type { Db } from "../../lib/server/db/client";
import { buildDraft, llmAvailable } from "../../lib/server/services/ai";
import { asActor, call, DEMO_USERS, freshDb } from "../helpers";

let db: Db;
const CM = DEMO_USERS.cmHaesol;
const A = DEMO_USERS.admin;
before(async () => {
  db = await freshDb();
});

/** Mock AI service: echoes one Korean sentence per section citing the first sent record of that request. */
function mockService(seen: any[]) {
  return (async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url: String(url), headers: init.headers, body });
    const first = body.records[0];
    const sections = body.sections.map((t: string, i: number) => ({ title: t, sentences: i === 0 ? [{ text: `${first.text} 내용이 확인되었습니다.`, source_ids: [first.id] }] : [] }));
    return new Response(JSON.stringify({ request_id: "req_00000000000000000abc", trace_id: (init.headers as any)["x-request-id"], status: "ok", reason: null, engine: "mock", model: "mock-model", prompt_version: "p1", sections, requires_human_review: true }), { status: 200, headers: { "content-type": "application/json", "x-request-id": (init.headers as any)["x-request-id"] } });
  }) as unknown as typeof fetch;
}

test("external inference stays disabled and the drafts API is still rule-based", async () => {
  assert.equal(llmAvailable(true), false);
  const g = await call(drafts.POST, { as: CM, body: { kind: "social_opinion", caseId: "case_3" } });
  assert.equal(g.status, 200);
  assert.equal(g.json.engine, "rules");
});

test("two-phase flow on real seed FactBooks: only allowlisted, non-identifying facts leave Gov", async () => {
  for (const [who, body] of [[A, { kind: "referral_summary", referralId: "ir_2" }], [CM, { kind: "social_opinion", caseId: "case_3" }], [CM, { kind: "meeting_brief", caseId: "case_3" }]] as const) {
    // phase 1: short tenant transaction — authorisation + facts + rule draft (no network)
    const built = await asActor(db, who, (tx, actor) => buildDraft(tx, actor, body as any));
    // phase 2: outside any transaction
    const seen: any[] = [];
    const provider = new AIIntelligenceProvider({ baseUrl: "http://127.0.0.1:8810", tokenForTenant: (t) => (t === "tn_gaon" ? "tok-gaon" : undefined), fetchImpl: mockService(seen) });
    const r = await composeDraft({ provider, tenantId: "tn_gaon", kind: body.kind, facts: built.facts, ruleDraft: built.content, dataClass: "synthetic" });
    const { sendable, excluded } = selectSendableFacts(built.facts);
    if (sendable.length) {
      assert.equal(seen.length, 1, body.kind);
      const sentIds = seen[0].body.records.map((x: any) => x.id);
      assert.deepEqual(sentIds, sendable.map((f) => f.id));
      // nothing typed freely by a person is in the request
      for (const f of built.facts.filter((f) => excluded.some((e) => e.id === f.id))) assert.ok(!JSON.stringify(seen[0].body).includes(f.text), `${body.kind}: ${f.sourceType}.${f.field} leaked`);
      assert.ok(built.facts.every((f) => f.sourceType !== "assessment_item" || !sentIds.includes(f.id)));
      assert.ok(verifyDraft(r.content, built.facts).ok);
      assert.ok(["hybrid", "ai-intelligence"].includes(r.engine), `${body.kind}: ${r.engine} ${r.fallbackReason}`);
    } else {
      assert.equal(r.fallbackReason, "no_sendable_facts");
    }
    assert.deepEqual(r.content.sections.map((s) => s.title), built.content.sections.map((s) => s.title));
  }
});

test("social opinion drafts depend on assessment answers (free text), so most sections stay rule-based", async () => {
  const built = await asActor(db, CM, (tx, actor) => buildDraft(tx, actor, { kind: "social_opinion", caseId: "case_3" }));
  const { excluded } = selectSendableFacts(built.facts);
  assert.ok(excluded.filter((e) => e.reason === "free_text").length >= 1);
  const r = await composeDraft({ provider: new AIIntelligenceProvider({ baseUrl: "http://127.0.0.1:8810", tokenForTenant: () => "t", fetchImpl: mockService([]) }), tenantId: "tn_gaon", kind: "social_opinion", facts: built.facts, ruleDraft: built.content, dataClass: "synthetic" });
  assert.ok(r.sectionEngines.filter((e) => e === "rules").length >= 4, r.sectionEngines.join(","));
});

test("authorisation still happens before any provider is involved", async () => {
  await assert.rejects(asActor(db, DEMO_USERS.cmMaru, (tx, actor) => buildDraft(tx, actor, { kind: "social_opinion", caseId: "case_3" })), /사례|not_found|찾을 수 없/);
});
