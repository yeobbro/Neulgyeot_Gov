/**
 * Draft review workflow: rule draft + AI draft in one group → compare → select (≠ approve) → approve.
 * AI drafts are produced by the real job pipeline with a local mock provider (no network).
 */
import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import * as review from "../../app/api/ai/drafts/[id]/review/route";
import * as select from "../../app/api/ai/drafts/[id]/select/route";
import * as compare from "../../app/api/ai/drafts/[id]/compare/route";
import * as aiJobs from "../../app/api/ai/drafts/[id]/ai-jobs/route";
import { runWorkerOnce } from "../../lib/server/ai/jobs";
import { withTenant, type Db } from "../../lib/server/db/client";
import { resetRateLimits } from "../../lib/server/http";
import { MockProvider } from "../ai-mock";
import { call, DEMO_USERS, freshDb } from "../helpers";

const T = "tn_gaon";
const A: string = DEMO_USERS.admin;
const CM: string = DEMO_USERS.cmHaesol; // assigned to ir_2 and case_3
const NOTE_TEXT = "퇴원 후 식사 준비 지원이 필요하다고 응답함";
let db: Db;
let seq = 0;
before(async () => {
  db = await freshDb();
  await db.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = 'tn_gaon'`);
});
beforeEach(async () => {
  resetRateLimits();
  // no job left over from a previous test may be picked up by this test's worker pass
  await db.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE status IN ('pending','processing')`);
});

const ruleDraft = async (body: Record<string, unknown> = { kind: "referral_summary", referralId: "ir_2" }, as = CM) => {
  const r = await call(drafts.POST, { as, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id as string;
};
const requestAi = (draftId: string, as = CM) => call(aiJobs.POST, { as, method: "POST", body: {}, params: { id: draftId }, headers: { "idempotency-key": `review-test-${++seq}-${draftId}` } });
/** Rule draft + AI draft in one group (job processed by a worker pass with the mock provider). */
async function group(body?: Record<string, unknown>, provider = new MockProvider()) {
  const rule = await ruleDraft(body);
  const q = await requestAi(rule);
  assert.equal(q.status, 200, JSON.stringify(q.json));
  const out = await runWorkerOnce(db, { tenantId: T, workerId: "wk_review", provider });
  const [ai] = await db.query<{ id: string }>(`SELECT id FROM ai_drafts WHERE draft_group_id = $1 AND id <> $1`, [rule]);
  return { rule, ai: ai?.id, jobId: q.json.jobId as string, outcome: out[0]?.outcome };
}
const sel = (id: string, action: "select" | "hold", as = CM) => call(select.POST, { as, params: { id }, body: { action } });
const rev = (id: string, action: "approve" | "discard", as = CM, extra: Record<string, unknown> = {}) => call(review.POST, { as, params: { id }, body: { action, ...extra } });
const row = async (id: string) => (await db.query<{ status: string; selection_status: string; selected_by: string | null; draft_group_id: string }>(`SELECT status, selection_status, selected_by, draft_group_id FROM ai_drafts WHERE id = $1`, [id]))[0];
const records = async () => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM case_records WHERE case_id = 'case_3' AND body LIKE '[검토 승인된%'`))[0].n);

test("1. rule draft and AI draft are created in the same group", async () => {
  const g = await group();
  assert.equal(g.outcome, "completed");
  assert.ok(g.ai);
  const [r, a] = [await row(g.rule), await row(g.ai)];
  assert.equal(r.draft_group_id, g.rule, "the rule draft is the group root");
  assert.equal(a.draft_group_id, g.rule);
  assert.deepEqual([r.status, a.status], ["draft", "draft"]);
  assert.deepEqual([r.selection_status, a.selection_status], ["candidate", "candidate"], "nothing is selected automatically");
});

test("2. compare: both drafts side by side with sentence marks and evidence; no note text, no auto decision", async () => {
  const g = await group();
  const c = await call(compare.GET, { as: CM, params: { id: g.ai } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.groupId, g.rule);
  assert.equal(c.json.canReview, true);
  assert.deepEqual(c.json.drafts.map((d: any) => d.source).sort(), ["ai", "rule_based"]);
  const cmp = c.json.comparison;
  assert.equal(cmp.ruleDraftId, g.rule);
  assert.equal(cmp.aiDraftId, g.ai);
  const { same, aiOnly, ruleOnly } = cmp.result.summary;
  assert.ok(aiOnly >= 1, "the AI sentence is marked as AI-only");
  assert.equal(same + aiOnly, cmp.result.sections.flatMap((s: any) => s.ai).length);
  assert.equal(ruleOnly, cmp.result.sections.flatMap((s: any) => s.rule).filter((x: any) => x.mark === "rule_only").length);
  // every AI sentence cites a fact that exists in the AI draft's own FactBook (validated on the server at creation)
  const aiDraft = c.json.drafts.find((d: any) => d.id === g.ai);
  const ids = new Set(aiDraft.content.facts.map((f: any) => f.id));
  for (const s of cmp.result.sections.flatMap((x: any) => x.ai)) for (const f of s.factIds) assert.ok(ids.has(f), f);
  assert.equal(aiDraft.content.ai.model, "mock-model");
  assert.equal(aiDraft.content.ai.promptVersion, "mock-p1");
  assert.ok(!JSON.stringify(c.json).includes(NOTE_TEXT), "note text never appears");
  assert.equal(c.json.selectedDraftId, null);
  assert.equal(c.json.approvedDraftId, null);
  assert.equal(c.json.job.status, "completed");
});

test("3. select the rule draft: selection only (no approval, no record); the AI draft is set aside", async () => {
  const g = await group();
  const r = await sel(g.rule, "select");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([(await row(g.rule)).selection_status, (await row(g.ai!)).selection_status], ["selected", "set_aside"]);
  assert.equal((await row(g.rule)).status, "draft", "selection is not approval");
  assert.equal((await row(g.rule)).selected_by, CM);
});

test("4. select the AI draft (and change the selection before approval)", async () => {
  const g = await group();
  assert.equal((await sel(g.rule, "select")).status, 200);
  assert.equal((await sel(g.ai!, "select")).status, 200);
  assert.deepEqual([(await row(g.rule)).selection_status, (await row(g.ai!)).selection_status], ["set_aside", "selected"]);
  const [a] = await db.query<{ meta: any }>(`SELECT meta FROM audit_logs WHERE action = 'ai.select' AND entity_id = $1`, [g.ai]);
  assert.equal(a.meta.previous, g.rule, "the previous selection is recorded");
});

test("5. discard the AI draft: it can be neither selected nor approved; the rule draft continues alone", async () => {
  const g = await group();
  assert.equal((await rev(g.ai!, "discard")).status, 200);
  assert.equal((await row(g.ai!)).status, "discarded");
  assert.equal((await sel(g.ai!, "select")).status, 409);
  assert.equal((await rev(g.ai!, "approve")).status, 409);
  assert.equal((await rev(g.rule, "approve")).status, 200, "only one live draft left → it can be approved directly");
});

test("6. hold (compare later): nothing selected, nothing approvable until a selection is made", async () => {
  const g = await group();
  await sel(g.ai!, "select");
  const h = await sel(g.rule, "hold");
  assert.equal(h.status, 200);
  assert.deepEqual([(await row(g.rule)).selection_status, (await row(g.ai!)).selection_status], ["candidate", "candidate"]);
  assert.equal((await rev(g.rule, "approve")).status, 409);
  assert.equal((await rev(g.ai!, "approve")).status, 409);
  assert.deepEqual([(await row(g.rule)).status, (await row(g.ai!)).status], ["draft", "draft"]);
});

test("7. approve after selection; the approved draft cannot be replaced by the other one", async () => {
  const g = await group();
  assert.equal((await rev(g.ai!, "approve")).status, 409, "unselected competing draft");
  await sel(g.ai!, "select");
  const ok = await rev(g.ai!, "approve", CM, { editedText: "검토 후 확정한 연계 요약입니다. 담당자 확인 완료." });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const a = await row(g.ai!);
  assert.deepEqual([a.status, a.selection_status], ["approved", "selected"]);
  assert.equal((await rev(g.rule, "approve")).status, 409);
  assert.equal((await sel(g.rule, "select")).status, 409);
  assert.equal((await sel(g.rule, "hold")).status, 409);
  assert.equal((await requestAi(g.rule)).status, 409, "no new AI job once the group is approved");
  const [ap] = await db.query<{ actor_id: string; meta: any; at: Date }>(`SELECT actor_id, meta, at FROM audit_logs WHERE action = 'ai.approve' AND entity_id = $1`, [g.ai]);
  assert.equal(ap.actor_id, CM);
  assert.equal(ap.meta.group, g.rule);
  assert.ok(ap.at);
});

test("8. no official case record before approval; only the approved draft becomes a record", async () => {
  const before = await records();
  const g = await group({ kind: "meeting_brief", caseId: "case_3" });
  assert.equal((await sel(g.ai!, "select")).status, 200);
  assert.equal(await records(), before, "selection writes no record");
  assert.equal((await rev(g.rule, "approve", CM, { saveAsRecord: true })).status, 409, "unselected draft");
  assert.equal(await records(), before);
  assert.equal((await rev(g.ai!, "approve", CM, { saveAsRecord: true })).status, 200);
  assert.equal(await records(), before + 1);
});

test("9. double selection is impossible (API moves the selection; the database refuses two)", async () => {
  const g = await group();
  await sel(g.rule, "select");
  await sel(g.ai!, "select");
  const n = await db.query(`SELECT 1 FROM ai_drafts WHERE draft_group_id = $1 AND selection_status = 'selected'`, [g.rule]);
  assert.equal(n.length, 1);
  await assert.rejects(
    db.query(`UPDATE ai_drafts SET selection_status = 'selected', selected_by = $2, selected_at = now() WHERE id = $1`, [g.rule, CM]),
    /ai_drafts_one_selected_per_group|unique/i,
  );
  await assert.rejects(db.query(`UPDATE ai_drafts SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [g.rule, CM]), /ai_drafts_approved_is_selected|check/i);
});

test("10. concurrent select / approve by two reviewers end in one consistent state", async () => {
  for (let i = 0; i < 3; i++) {
    const g = await group();
    await sel(g.rule, "select");
    const res = await Promise.all([rev(g.rule, "approve", CM), sel(g.ai!, "select", A), rev(g.ai!, "approve", A), sel(g.rule, "hold", A)]);
    const rows = await db.query<{ id: string; status: string; selection_status: string }>(`SELECT id, status, selection_status FROM ai_drafts WHERE draft_group_id = $1`, [g.rule]);
    const approved = rows.filter((r) => r.status === "approved");
    const selected = rows.filter((r) => r.selection_status === "selected");
    assert.ok(approved.length <= 1, JSON.stringify(rows));
    assert.ok(selected.length <= 1, JSON.stringify(rows));
    if (approved.length) assert.equal(approved[0].selection_status, "selected");
    assert.ok(res.every((r) => r.status === 200 || r.status === 409), res.map((r) => r.status).join(","));
  }
});

test("11. tenant isolation: another tenant can neither see nor select nor approve", async () => {
  const g = await group();
  for (const id of [g.rule, g.ai!]) {
    assert.equal((await call(compare.GET, { as: DEMO_USERS.otherAdmin, params: { id } })).status, 404);
    assert.equal((await sel(id, "select", DEMO_USERS.otherAdmin)).status, 404);
    assert.equal((await sel(id, "hold", DEMO_USERS.otherAdmin)).status, 404);
    assert.equal((await rev(id, "approve", DEMO_USERS.otherAdmin)).status, 404);
  }
  assert.deepEqual(await withTenant(db, "tn_nuri", (tx) => tx.query(`UPDATE ai_drafts SET selection_status = 'candidate' WHERE id = $1 RETURNING id`, [g.ai])), []);
  assert.equal((await row(g.ai!)).selection_status, "candidate");
});

test("12. region and assignment: out-of-region 404; in-region read-only can compare but not select", async () => {
  const g = await group();
  assert.equal((await call(compare.GET, { as: DEMO_USERS.cmMaru, params: { id: g.ai } })).status, 404);
  assert.equal((await sel(g.ai!, "select", DEMO_USERS.cmMaru)).status, 404);
  assert.equal((await call(compare.GET, { as: DEMO_USERS.auditor, params: { id: g.ai } })).status, 404);
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [A]);
  try {
    const c = await call(compare.GET, { as: CM, params: { id: g.ai } });
    assert.equal(c.status, 200);
    assert.equal(c.json.canReview, false);
    assert.equal((await sel(g.ai!, "select", CM)).status, 403);
    assert.equal((await sel(g.ai!, "hold", CM)).status, 403);
    assert.equal((await requestAi(g.rule, CM)).status, 403);
  } finally {
    await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [CM]);
  }
  assert.equal((await sel(g.ai!, "select", A)).status, 200, "admin may select");
});

test("13. audit trail: select, hold, approve with actor, target, group and time — no content", async () => {
  const g = await group();
  await sel(g.ai!, "select");
  await sel(g.rule, "hold", A);
  await sel(g.rule, "select");
  await rev(g.rule, "approve");
  const rows = await db.query<{ action: string; actor_id: string; entity_id: string; meta: any; at: Date }>(
    `SELECT action, actor_id, entity_id, meta, at FROM audit_logs WHERE action IN ('ai.select','ai.hold','ai.approve') AND (meta->>'group') = $1 ORDER BY at, id`, [g.rule]);
  assert.deepEqual(rows.map((r) => [r.action, r.actor_id]), [["ai.select", CM], ["ai.hold", A], ["ai.select", CM], ["ai.approve", CM]]);
  assert.ok(rows.every((r) => r.at && r.entity_id));
  const facts = (await db.query<{ c: any }>(`SELECT content AS c FROM ai_drafts WHERE id = $1`, [g.ai]))[0].c.facts as { text: string }[];
  const all = JSON.stringify(rows);
  for (const f of facts) assert.ok(!all.includes(f.text));
});

test("14. AI failure: job fails with a safe message, no AI draft, the rule draft stays usable and approvable", async () => {
  const g = await group(undefined, new MockProvider(["invalid_response"]));
  assert.equal(g.outcome, "failed");
  assert.equal(g.ai, undefined);
  const c = await call(compare.GET, { as: CM, params: { id: g.rule } });
  assert.equal(c.json.comparison, null);
  assert.equal(c.json.job.status, "failed");
  assert.equal(c.json.job.error.message, "AI 응답 형식이 올바르지 않습니다.");
  assert.equal(c.json.job.canRequestAgain, true);
  assert.ok(!JSON.stringify(c.json).includes("tok-SECRET"));
  assert.equal((await rev(g.rule, "approve")).status, 200);
});

test("AI request API: kill switch off → 409; Idempotency-Key required; repeat click returns the same job", async () => {
  const rule = await ruleDraft();
  assert.equal((await call(aiJobs.POST, { as: CM, method: "POST", body: {}, params: { id: rule } })).status, 400);
  const h = { "idempotency-key": "same-click-key-0001" };
  const a = await call(aiJobs.POST, { as: CM, method: "POST", body: {}, params: { id: rule }, headers: h });
  const b = await call(aiJobs.POST, { as: CM, method: "POST", body: {}, params: { id: rule }, headers: h });
  assert.equal(a.status, 200);
  assert.equal(b.json.jobId, a.json.jobId);
  assert.equal(b.json.created, false);
  assert.equal((await call(aiJobs.POST, { as: CM, method: "POST", body: {}, params: { id: rule }, headers: h, csrf: false })).status, 403, "CSRF unchanged");
  await db.query(`UPDATE tenant_settings SET ai_enabled = false WHERE tenant_id = 'tn_gaon'`);
  try {
    const rule2 = await ruleDraft();
    const off = await requestAi(rule2);
    assert.equal(off.status, 409);
    assert.match(off.json.error.message, /꺼져/);
  } finally {
    await db.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = 'tn_gaon'`);
  }
});

test("a draft carries exactly one target matching its kind (review finding: case id attached to a referral draft)", async () => {
  for (const body of [
    { kind: "referral_summary", referralId: "ir_2", caseId: "case_3" },
    { kind: "meeting_brief", caseId: "case_3", referralId: "ir_2" },
    { kind: "referral_summary", caseId: "case_3" },
    { kind: "social_opinion", referralId: "ir_2" },
  ]) {
    const r = await call(drafts.POST, { as: CM, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // even a row written around the API (both ids) is never reviewable
  const rule = await ruleDraft();
  await db.query(`ALTER TABLE ai_drafts DROP CONSTRAINT ai_drafts_one_target`);
  try {
    await db.query(`UPDATE ai_drafts SET case_id = 'case_3' WHERE id = $1`, [rule]);
    assert.equal((await rev(rule, "approve")).status, 404);
    assert.equal((await call(compare.GET, { as: CM, params: { id: rule } })).status, 404);
    await db.query(`UPDATE ai_drafts SET case_id = NULL WHERE id = $1`, [rule]);
  } finally {
    await db.query(`ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_one_target CHECK (num_nonnulls(case_id, referral_id) = 1) NOT VALID`);
  }
  await assert.rejects(db.query(`UPDATE ai_drafts SET case_id = 'case_3' WHERE id = $1`, [rule]), /ai_drafts_one_target|check/i, "the constraint enforces it for new writes");
});
