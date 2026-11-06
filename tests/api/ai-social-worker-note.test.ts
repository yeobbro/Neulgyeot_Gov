/** Social worker note: rule drafts show that it exists; its text and its presence never reach an AI provider. */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import { selectSendableFacts } from "../../lib/server/ai/fact-policy";
import { AIIntelligenceProvider, composeDraft } from "../../lib/server/ai/provider";
import type { Db } from "../../lib/server/db/client";
import { buildDraft, SOCIAL_WORKER_NOTE_PRESENT } from "../../lib/server/services/ai";
import { asActor, call, DEMO_USERS, freshDb } from "../helpers";

const NOTE_TEXT = "퇴원 후 식사 준비 지원이 필요하다고 응답함"; // seed note for every demo referral
const A = DEMO_USERS.admin;
let db: Db;
before(async () => {
  db = await freshDb();
});

test("1. the rule draft says a social worker note is attached", async () => {
  const r = await call(drafts.POST, { as: A, body: { kind: "referral_summary", referralId: "ir_2" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.text.includes("병원 사회복지사 소견이 첨부되었습니다."), r.json.text);
  const noteFact = r.json.facts.find((f: any) => f.field === "livingNeeds.socialWorkerNote");
  assert.equal(noteFact.text, SOCIAL_WORKER_NOTE_PRESENT);
  const cited = r.json.sections.flatMap((s: any) => s.sentences).find((x: any) => x.text === "병원 사회복지사 소견이 첨부되었습니다.");
  assert.deepEqual(cited.factIds, [noteFact.id]);
});

test("2. the note text is not in the API response, the stored draft or its source references", async () => {
  const r = await call(drafts.POST, { as: A, body: { kind: "referral_summary", referralId: "ir_2" } });
  assert.ok(!JSON.stringify(r.json).includes(NOTE_TEXT));
  const [d] = await db.query<{ c: string }>(`SELECT content::text AS c FROM ai_drafts WHERE id = $1`, [r.json.id]);
  assert.ok(!d.c.includes(NOTE_TEXT));
  const refs = await db.query<{ field: string }>(`SELECT field FROM ai_source_references WHERE draft_id = $1`, [r.json.id]);
  assert.ok(refs.some((x) => x.field === "livingNeeds.socialWorkerNote"), "the sentence still links to its source record");
});

test("3. a provider request contains neither the note text nor the note's presence", async () => {
  const built = await asActor(db, A, (tx, actor) => buildDraft(tx, actor, { kind: "referral_summary", referralId: "ir_2" }));
  const noteFact = built.facts.find((f) => f.field === "livingNeeds.socialWorkerNote")!;
  assert.ok(noteFact);
  for (const allowFreeText of [false, true]) {
    const { sendable, excluded } = selectSendableFacts(built.facts, { allowFreeText });
    assert.ok(!sendable.some((f) => f.id === noteFact.id), `allowFreeText=${allowFreeText}`);
    assert.equal(excluded.find((e) => e.id === noteFact.id)!.reason, "never_send");
  }
  const sent: string[] = [];
  const fetchImpl = (async (_u: URL, init: RequestInit) => {
    sent.push(String(init.body));
    return new Response(JSON.stringify({ request_id: "req_00000000000000000001", trace_id: "t", status: "no_result", reason: "llm_disabled", engine: "x", model: null, prompt_version: "p", sections: [], requires_human_review: true }), { status: 200 });
  }) as unknown as typeof fetch;
  await composeDraft({ provider: new AIIntelligenceProvider({ baseUrl: "http://127.0.0.1:1", tokenForTenant: () => "t", fetchImpl }), tenantId: "tn_gaon", kind: "referral_summary", facts: built.facts, ruleDraft: built.content });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes(NOTE_TEXT) && !sent[0].includes("소견") && !sent[0].includes(`"${noteFact.id}"`));
});

test("4. other free-text fields from real seed data are not sent either", async () => {
  const cases = [
    { who: A, body: { kind: "referral_summary", referralId: "ir_2" } },
    { who: DEMO_USERS.cmHaesol, body: { kind: "social_opinion", caseId: "case_3" } },
    { who: DEMO_USERS.cmHaesol, body: { kind: "meeting_brief", caseId: "case_3" } },
  ] as const;
  const isFreeText = (f: { sourceType: string; field: string }) =>
    f.sourceType === "assessment_item" || f.sourceType === "home_environment" ||
    (f.sourceType === "incoming_referral" && f.field === "missing_items") || f.field === "livingNeeds.socialWorkerNote";
  let seenFreeText = 0;
  for (const c of cases) {
    const built = await asActor(db, c.who, (tx, actor) => buildDraft(tx, actor, c.body as any));
    const sentIds = new Set(selectSendableFacts(built.facts).sendable.map((f) => f.id));
    for (const f of built.facts.filter(isFreeText)) {
      seenFreeText++;
      assert.ok(!sentIds.has(f.id), `${c.body.kind}: ${f.sourceType}.${f.field} must not be sent`);
    }
  }
  assert.ok(seenFreeText >= 3, `seed data must exercise free-text facts (saw ${seenFreeText})`);
});
