/** Regression tests for the second PR self-review (breaker probe, provider-supplied codes, data class, migration
 * backfill, target guard, shutdown batch release, per-claim lease token). Synthetic data, no network. */
import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import { claimJobs, enqueueDraftJob, releaseJob, runJob, runWorkerOnce, type AiJob } from "../../lib/server/ai/jobs";
import { AIIntelligenceProvider, CircuitBreaker } from "../../lib/server/ai/provider";
import { AiWorker } from "../../lib/server/ai/worker";
import { openDb, type Db } from "../../lib/server/db/client";
import * as m006 from "../../lib/server/db/migrations/006_ai_draft_review";
import { seed } from "../../lib/server/db/seed";
import { resetRateLimits } from "../../lib/server/http";
import { listDraftGroups } from "../../lib/server/services/ai-review";
import { MockProvider } from "../ai-mock";
import { asActor, call, DEMO_USERS, freshDb } from "../helpers";

const T = "tn_gaon";
const CM: string = DEMO_USERS.cmHaesol;
let db: Db;
let seq = 0;
before(async () => {
  db = await freshDb();
  await db.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = 'tn_gaon'`);
});
beforeEach(async () => {
  resetRateLimits();
  await db.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE status IN ('pending','processing')`);
});
const newJob = async (body: Record<string, unknown> = { kind: "referral_summary", referralId: "ir_2" }) => {
  const r = await call(drafts.POST, { as: CM, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return (await asActor(db, CM, (tx, a) => enqueueDraftJob(tx, a, { draftId: r.json.id, idempotencyKey: `hardening-${++seq}` }))).job;
};
const job = async (id: string) => (await db.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1`, [id]))[0];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const httpProvider = (steps: (() => Response)[], breaker?: CircuitBreaker) =>
  new AIIntelligenceProvider({
    baseUrl: "http://127.0.0.1:1", tokenForTenant: () => "tok", timeoutMs: 200, breaker,
    fetchImpl: (async () => { const s = steps.shift(); if (!s) throw new TypeError("fetch failed"); return s(); }) as unknown as typeof fetch,
  });

test("breaker: a half-open probe that ends in 4xx or trace mismatch never leaves the breaker stuck", async () => {
  let now = 0;
  const b = new CircuitBreaker(3, 1000, () => now);
  const steps: (() => Response)[] = [];
  const p = httpProvider(steps, b);
  for (let i = 0; i < 3; i++) await assert.rejects(p.proposeDraft({ tenantId: T, kind: "referral_summary", sectionTitles: ["a"], facts: [{ id: "F1", text: "x" } as any], traceId: "t1" }));
  assert.equal(b.state, "open");
  now = 2000;
  steps.push(() => json(401, { error: { code: "token_expired", message: "x" } })); // the probe gets a 4xx
  await assert.rejects(p.proposeDraft({ tenantId: T, kind: "referral_summary", sectionTitles: ["a"], facts: [{ id: "F1", text: "x" } as any], traceId: "t2" }), /요청 거부/);
  assert.equal(b.state, "closed", "a reachable service closes the breaker");
  assert.equal(b.allow(), true);
  // a probe that throws without a verdict still releases the probe slot
  const b2 = new CircuitBreaker(1, 1000, () => now);
  b2.failure();
  now = 5000;
  assert.equal(b2.allow(), true);
  assert.equal(b2.allow(), false, "only one probe at a time");
  b2.release();
  assert.equal(b2.allow(), true, "released probe slot can be used again");
});

test("provider-supplied internal codes (e.g. circuit_open) are not trusted: no deferral, no attempt refund", async () => {
  const j = await newJob();
  const p = httpProvider([() => json(409, { error: { code: "circuit_open", message: "x" } })]);
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_pc", provider: p }))[0].outcome, "failed");
  const r = await job(j.id);
  assert.equal(r.error_code, "provider_error");
  assert.equal(r.attempt_count, 1);
  const j2 = await newJob();
  const okNoResult = { request_id: "req_00000000000000000001", trace_id: "x", status: "no_result", reason: "circuit_open", engine: "e", model: null, prompt_version: "p", sections: [], requires_human_review: true };
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_pc", provider: httpProvider([() => json(200, okNoResult)]) }))[0].outcome, "failed");
  assert.equal((await job(j2.id)).error_code, "provider_error");
});

test("data class: a referral linked to a case with a real recipient is blocked", async () => {
  const [{ case_id: prev }] = await db.query<{ case_id: string | null }>(`SELECT case_id FROM incoming_referrals WHERE id = 'ir_2'`);
  const j = await newJob();
  await db.query(`UPDATE incoming_referrals SET case_id = 'case_3' WHERE id = 'ir_2'`);
  await db.query(`UPDATE care_recipients SET is_synthetic = false WHERE id = (SELECT recipient_id FROM care_cases WHERE id = 'case_3')`);
  const p = new MockProvider();
  try {
    await runWorkerOnce(db, { tenantId: T, workerId: "wk_dc", provider: p });
  } finally {
    await db.query(`UPDATE care_recipients SET is_synthetic = true WHERE id = (SELECT recipient_id FROM care_cases WHERE id = 'case_3')`);
    await db.query(`UPDATE incoming_referrals SET case_id = $1 WHERE id = 'ir_2'`, [prev]);
  }
  assert.equal((await job(j.id)).error_code, "real_data_blocked");
  assert.equal(p.calls, 0);
});

test("migration 006 backfill: a legacy group with two approvals is split, nothing is un-approved or deleted", async () => {
  const fresh = await openDb({ url: null });
  await fresh.transaction((tx) => seed(tx));
  await fresh.exec(m006.down);
  const ins = (id: string, status: string, extra: string, reviewedAt: string) =>
    fresh.query(`INSERT INTO ai_drafts (id, tenant_id, referral_id, kind, engine, status, content, created_by, reviewed_by, reviewed_at)
                 VALUES ($1,'tn_gaon','ir_2','referral_summary',$2,$3,$4,'usr_gaon_cm1',$5,$6)`,
      [id, extra ? "hybrid" : "rules", status, JSON.stringify({ sections: [], facts: [], text: "x", ...(extra ? { ai: { sourceDraftId: extra } } : {}) }), status === "draft" ? null : "usr_gaon_cm1", status === "draft" ? null : reviewedAt]);
  await ins("aid_l_rule", "approved", "", "2026-01-02");
  await ins("aid_l_ai1", "approved", "aid_l_rule", "2026-01-01");
  await ins("aid_l_ai2", "discarded", "aid_l_rule", "2026-01-03");
  await ins("aid_l_r2", "draft", "", "");
  await ins("aid_l_r2a", "approved", "aid_l_r2", "2026-01-04");
  await ins("aid_l_r2b", "approved", "aid_l_r2", "2026-01-05");
  await fresh.exec(m006.up);
  const rows = Object.fromEntries((await fresh.query<{ id: string; draft_group_id: string; status: string; selection_status: string }>(
    `SELECT id, draft_group_id, status, selection_status FROM ai_drafts WHERE id LIKE 'aid_l_%'`)).map((r) => [r.id, r]));
  assert.equal(rows.aid_l_rule.draft_group_id, "aid_l_rule");
  assert.equal(rows.aid_l_ai1.draft_group_id, "aid_l_ai1", "second approval in the group gets its own group");
  assert.equal(rows.aid_l_ai2.draft_group_id, "aid_l_rule");
  assert.equal(rows.aid_l_r2a.draft_group_id, "aid_l_r2", "earliest approval stays when the root is not approved");
  assert.equal(rows.aid_l_r2b.draft_group_id, "aid_l_r2b");
  for (const id of ["aid_l_rule", "aid_l_ai1", "aid_l_r2a", "aid_l_r2b"]) assert.deepEqual([rows[id].status, rows[id].selection_status], ["approved", "selected"]);
  assert.equal(rows.aid_l_ai2.selection_status, "set_aside");
  await fresh.close();
});

test("draft groups shown on a page only contain drafts whose single target is that page", async () => {
  const r = await call(drafts.POST, { as: CM, body: { kind: "social_opinion", caseId: "case_3" } });
  await db.query(`ALTER TABLE ai_drafts DROP CONSTRAINT ai_drafts_one_target`);
  try {
    await db.query(`UPDATE ai_drafts SET referral_id = 'ir_2' WHERE id = $1`, [r.json.id]); // legacy dual-target row
    const ref = await asActor(db, CM, (tx) => listDraftGroups(tx, { referralId: "ir_2" }));
    const cs = await asActor(db, CM, (tx) => listDraftGroups(tx, { caseId: "case_3" }));
    assert.ok(!ref.some((g) => g.drafts.some((d) => d.id === r.json.id)), "not on the referral page");
    assert.ok(!cs.some((g) => g.drafts.some((d) => d.id === r.json.id)), "not on the case page either");
    await db.query(`UPDATE ai_drafts SET referral_id = NULL WHERE id = $1`, [r.json.id]);
  } finally {
    await db.query(`ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_one_target CHECK (num_nonnulls(case_id, referral_id) = 1) NOT VALID`);
  }
});

test("shutdown releases the whole claimed batch, not only the running job", async () => {
  const jobs = [await newJob(), await newJob(), await newJob()];
  const slow = new MockProvider([{ hangMs: 300 }]);
  const w = new AiWorker({ db, provider: slow, workerId: "wk_batch", perTenantLimit: 3, pollMs: 10, tenants: async () => [T] });
  w.start();
  const end = Date.now() + 3000;
  while (slow.calls === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  await w.stop(20);
  const st = await Promise.all(jobs.map((j) => job(j.id)));
  assert.deepEqual(st.map((j) => j.status), ["pending", "pending", "pending"]);
  assert.deepEqual(st.map((j) => j.attempt_count), [0, 0, 0], "attempts refunded");
  assert.equal(w.health().counters.released, 3);
  await new Promise((r) => setTimeout(r, 350));
});

test("per-claim lease token: the same worker id re-claiming after a release is a different lease", async () => {
  const j = await newJob();
  const [first] = await claimJobs(db, { tenantId: T, workerId: "wk_same" });
  assert.ok(await releaseJob(db, first, "wk_same"));
  const [second] = await claimJobs(db, { tenantId: T, workerId: "wk_same" });
  assert.equal(second.id, j.id);
  assert.equal(second.attempt_count, first.attempt_count, "attempt was refunded, so the number alone would collide");
  assert.notEqual(second.lease_owner, first.lease_owner);
  const p = new MockProvider();
  assert.equal(await runJob(db, first, { provider: p, workerId: "wk_same" }), "stale", "the old lease cannot write");
  assert.equal(p.calls, 0);
  assert.equal(await runJob(db, second, { provider: p, workerId: "wk_same" }), "completed");
});

test("provider-reported server-side reasons keep their meaning without steering retries", async () => {
  const body = (reason: string) => ({ request_id: "req_00000000000000000002", trace_id: "x", status: "no_result", reason, engine: "e", model: null, prompt_version: "p", sections: [], requires_human_review: true });
  for (const [reason, stored] of [["unavailable", "llm_unavailable"], ["timeout", "timeout"], ["invalid_json", "invalid_json"], ["network", "provider_error"]] as const) {
    const j = await newJob();
    assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_rs", provider: httpProvider([() => json(200, body(reason))]) }))[0].outcome, "failed", reason);
    const r = await job(j.id);
    assert.equal(r.error_code, stored, reason);
    assert.equal(r.attempt_count, 1, `${reason}: not retried, not refunded`);
  }
});
