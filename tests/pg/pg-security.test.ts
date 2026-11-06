/**
 * RLS, tenant isolation, approval permissions and review-workflow concurrency on real PostgreSQL. Unlike PGlite
 * (one connection, serialised), these run on a connection pool: transactions really overlap and row locks block.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import * as review from "../../app/api/ai/drafts/[id]/review/route";
import * as select from "../../app/api/ai/drafts/[id]/select/route";
import * as compare from "../../app/api/ai/drafts/[id]/compare/route";
import * as aiJobs from "../../app/api/ai/drafts/[id]/ai-jobs/route";
import { runWorkerOnce } from "../../lib/server/ai/jobs";
import { setDbForTesting, withTenant, type Db } from "../../lib/server/db/client";
import { seed } from "../../lib/server/db/seed";
import { resetRateLimits } from "../../lib/server/http";
import { MockProvider } from "../ai-mock";
import { call, DEMO_USERS } from "../helpers";
import { createTestDb, SKIP, type TestDb } from "./pg-helpers";

const T = "tn_gaon";
const A: string = DEMO_USERS.admin;
const CM: string = DEMO_USERS.cmHaesol;
let t: TestDb;
let db: Db;
let seq = 0;
before(async () => {
  if (SKIP) return;
  process.env.DATABASE_POOL_MAX = "12";
  t = await createTestDb();
  db = t.db;
  await db.transaction((tx) => seed(tx));
  await db.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = 'tn_gaon'`);
  setDbForTesting(db);
});
after(async () => {
  if (SKIP) return;
  setDbForTesting(undefined);
  await t.drop();
});
beforeEach(async () => {
  if (SKIP) return;
  resetRateLimits();
  await db.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE status IN ('pending','processing')`);
});

const ruleDraft = async (body: Record<string, unknown> = { kind: "referral_summary", referralId: "ir_2" }) => {
  const r = await call(drafts.POST, { as: CM, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id as string;
};
const requestAi = (id: string, as = CM, key = `pg-sec-${++seq}-${id}`) => call(aiJobs.POST, { as, method: "POST", body: {}, params: { id }, headers: { "idempotency-key": key } });
async function group() {
  const rule = await ruleDraft();
  assert.equal((await requestAi(rule)).status, 200);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_pgsec", provider: new MockProvider() });
  const [ai] = await db.query<{ id: string }>(`SELECT id FROM ai_drafts WHERE draft_group_id = $1 AND id <> $1`, [rule]);
  assert.ok(ai, "AI draft created");
  return { rule, ai: ai.id };
}
const sel = (id: string, action: "select" | "hold", as = CM) => call(select.POST, { as, params: { id }, body: { action } });
const rev = (id: string, action: "approve" | "discard", as = CM) => call(review.POST, { as, params: { id }, body: { action } });

test("RLS on real PostgreSQL: other tenant sees and changes nothing; cross-tenant insert refused; no tenant → nothing", { skip: SKIP }, async () => {
  const g = await group();
  for (const table of ["ai_drafts", "ai_jobs", "ai_source_references", "audit_logs", "incoming_referrals"]) {
    const seen = await withTenant(db, "tn_nuri", (tx) => tx.query(`SELECT 1 FROM ${table} WHERE tenant_id = 'tn_gaon' LIMIT 1`));
    assert.deepEqual(seen, [], `${table} hidden from tn_nuri`);
    assert.deepEqual(await withTenant(db, "", (tx) => tx.query(`SELECT 1 FROM ${table} LIMIT 1`)), [], `${table} fail-closed without tenant`);
  }
  assert.deepEqual(await withTenant(db, "tn_nuri", (tx) => tx.query(`UPDATE ai_drafts SET status = 'discarded' WHERE id = $1 RETURNING id`, [g.ai])), []);
  assert.deepEqual(await withTenant(db, "tn_nuri", (tx) => tx.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now() RETURNING id`)), []);
  await assert.rejects(withTenant(db, "tn_nuri", (tx) => tx.query(
    `INSERT INTO ai_jobs (id, tenant_id, draft_id, job_type, requested_by, idempotency_key) VALUES ('aij_x','tn_gaon',$1,'draft_compose','usr_gaon_cm1','pg-cross-tenant-1')`, [g.rule])), /row-level security/);
  await assert.rejects(withTenant(db, T, (tx) => tx.query(`DELETE FROM ai_jobs`)), /permission denied/, "app role cannot DELETE jobs");
  await assert.rejects(withTenant(db, T, (tx) => tx.query(`UPDATE audit_logs SET outcome = 'x'`)), /permission denied/, "audit log is append-only");
  const [r] = await db.query<{ status: string }>(`SELECT status FROM ai_drafts WHERE id = $1`, [g.ai]);
  assert.equal(r.status, "draft");
});

test("approval permissions through the API on real PostgreSQL", { skip: SKIP }, async () => {
  const g = await group();
  for (const who of [DEMO_USERS.otherAdmin, DEMO_USERS.cmMaru, DEMO_USERS.auditor, DEMO_USERS.providerNursing]) {
    assert.equal((await call(compare.GET, { as: who, params: { id: g.ai } })).status, 404, `${who} compare`);
    assert.equal((await sel(g.ai, "select", who)).status, 404, `${who} select`);
    assert.equal((await rev(g.ai, "approve", who)).status, 404, `${who} approve`);
  }
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [A]);
  try {
    assert.equal((await call(compare.GET, { as: CM, params: { id: g.ai } })).json.canReview, false);
    assert.equal((await sel(g.ai, "select")).status, 403);
    assert.equal((await rev(g.ai, "approve")).status, 403);
    assert.equal((await requestAi(g.rule)).status, 403);
  } finally {
    await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [CM]);
  }
  assert.equal((await rev(g.ai, "approve")).status, 409, "selection required with competing drafts");
  assert.equal((await sel(g.ai, "select")).status, 200);
  assert.equal((await rev(g.ai, "approve")).status, 200);
  const [a] = await db.query<{ actor_id: string }>(`SELECT actor_id FROM audit_logs WHERE action = 'ai.approve' AND entity_id = $1`, [g.ai]);
  assert.equal(a.actor_id, CM);
});

test("truly concurrent select / approve / hold by two reviewers: one consistent outcome every time", { skip: SKIP }, async () => {
  for (let i = 0; i < 6; i++) {
    resetRateLimits();
    const g = await group();
    await sel(g.rule, "select");
    const res = await Promise.all([rev(g.rule, "approve", CM), sel(g.ai, "select", A), rev(g.ai, "approve", A), sel(g.rule, "hold", A), sel(g.ai, "select", CM)]);
    assert.ok(res.every((r) => r.status === 200 || r.status === 409), res.map((r) => `${r.status}:${JSON.stringify(r.json).slice(0, 80)}`).join(" | "));
    const rows = await db.query<{ status: string; selection_status: string }>(`SELECT status, selection_status FROM ai_drafts WHERE draft_group_id = $1`, [g.rule]);
    assert.ok(rows.filter((r) => r.status === "approved").length <= 1, JSON.stringify(rows));
    assert.ok(rows.filter((r) => r.selection_status === "selected").length <= 1, JSON.stringify(rows));
    for (const r of rows) if (r.status === "approved") assert.equal(r.selection_status, "selected");
  }
});

test("a sibling committed while an approval waits for the group lock is seen (no silent approval)", { skip: SKIP }, async () => {
  const rule = await ruleDraft();
  let approval: Promise<{ status: number; json: any }> | null = null;
  await withTenant(db, T, async (tx) => {
    // stands in for job phase 3: holds the root row lock and inserts an AI sibling
    await tx.query(`SELECT 1 FROM ai_drafts WHERE id = $1 FOR UPDATE`, [rule]);
    const [root] = await tx.query<{ content: unknown }>(`SELECT content FROM ai_drafts WHERE id = $1`, [rule]);
    await tx.query(`INSERT INTO ai_drafts (id, tenant_id, referral_id, kind, engine, status, content, created_by, draft_group_id)
                    VALUES ($1, 'tn_gaon', 'ir_2', 'referral_summary', 'hybrid', 'draft', $2, 'usr_gaon_cm1', $3)`, [`aid_sib_${seq++}`, JSON.stringify(root.content), rule]);
    approval = rev(rule, "approve"); // blocks on the lock in another connection
    await new Promise((r) => setTimeout(r, 400));
  });
  const r = await approval!;
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error.message, /선택/);
  const [st] = await db.query<{ status: string }>(`SELECT status FROM ai_drafts WHERE id = $1`, [rule]);
  assert.equal(st.status, "draft");
});

test("concurrent AI requests: same key or same draft → exactly one job, no 500", { skip: SKIP }, async () => {
  const rule = await ruleDraft();
  const sameKey = await Promise.all(Array.from({ length: 8 }, () => requestAi(rule, CM, `pg-same-key-${rule}`)));
  assert.ok(sameKey.every((r) => r.status === 200), sameKey.map((r) => r.status).join(","));
  assert.equal(new Set(sameKey.map((r) => r.json.jobId)).size, 1);
  const rule2 = await ruleDraft();
  const diffKeys = await Promise.all(Array.from({ length: 8 }, (_, i) => requestAi(rule2, CM, `pg-diff-key-${i}-${rule2}`)));
  assert.ok(diffKeys.every((r) => r.status === 200 || r.status === 409), diffKeys.map((r) => r.status).join(","));
  const jobs = await db.query(`SELECT 1 FROM ai_jobs WHERE draft_id = $1`, [rule2]);
  assert.equal(jobs.length, 1);
  const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_jobs WHERE draft_id = $1`, [rule]);
  assert.equal(n, 1);
});
