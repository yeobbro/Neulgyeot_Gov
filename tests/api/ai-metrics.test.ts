/** AI observability: admin-only, tenant-scoped, content-free aggregates over real job/draft rows. */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import * as review from "../../app/api/ai/drafts/[id]/review/route";
import * as select from "../../app/api/ai/drafts/[id]/select/route";
import * as metrics from "../../app/api/admin/ai-metrics/route";
import { enqueueDraftJob, runWorkerOnce } from "../../lib/server/ai/jobs";
import type { Db } from "../../lib/server/db/client";
import { resetRateLimits } from "../../lib/server/http";
import { MockProvider } from "../ai-mock";
import { asActor, call, DEMO_USERS, freshDb } from "../helpers";

const CM: string = DEMO_USERS.cmHaesol;
const A: string = DEMO_USERS.admin;
let db: Db;
let seq = 0;
const facts: string[] = [];
before(async () => {
  db = await freshDb();
  await db.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = 'tn_gaon'`);
  // 3 completed (1 approved, 1 discarded, 1 open), 1 failed (timeout), 1 failed (invalid), 1 retried then completed
  const steps = [["ok"], ["ok"], ["ok"], [{ hangMs: 200 }], ["invalid_response"], ["network", "ok"]] as const;
  const ai: string[] = [];
  for (const s of steps) {
    resetRateLimits();
    const d = await call(drafts.POST, { as: CM, body: { kind: "referral_summary", referralId: "ir_2" } });
    facts.push(...d.json.facts.map((f: any) => f.text));
    const { job } = await asActor(db, CM, (tx, actor) => enqueueDraftJob(tx, actor, { draftId: d.json.id, idempotencyKey: `metrics-${++seq}` }));
    const p = new MockProvider([...s] as any);
    await runWorkerOnce(db, { tenantId: "tn_gaon", workerId: "wk_m", provider: p, jobTimeoutMs: 50 });
    if (s[0] === "network") {
      await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [job.id]);
      await runWorkerOnce(db, { tenantId: "tn_gaon", workerId: "wk_m", provider: p });
    }
    const [r] = await db.query<{ result_draft_id: string | null }>(`SELECT result_draft_id FROM ai_jobs WHERE id = $1`, [job.id]);
    if (r.result_draft_id) ai.push(r.result_draft_id);
  }
  await call(select.POST, { as: CM, params: { id: ai[0] }, body: { action: "select" } });
  await call(review.POST, { as: CM, params: { id: ai[0] }, body: { action: "approve" } });
  await call(review.POST, { as: CM, params: { id: ai[1] }, body: { action: "discard" } });
});

test("metrics: counts, rates, durations, failure codes and review outcomes", async () => {
  const r = await call(metrics.GET, { as: A, url: "/api/admin/ai-metrics?days=30" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const m = r.json;
  assert.deepEqual(m.jobs, { requested: 6, pending: 0, processing: 0, completed: 4, failed: 2, cancelled: 0 });
  assert.equal(m.successRate, 0.667);
  assert.equal(m.failureRate, 0.333);
  assert.equal(m.ruleFallbackRate, 0.333);
  assert.equal(m.timeoutRate, 0.167);
  assert.equal(m.retries, 1);
  assert.deepEqual(m.failureCodes.map((c: any) => c.code).sort(), ["invalid_response", "job_timeout"]);
  assert.ok(m.durationSeconds.avg !== null && m.durationSeconds.p95 !== null && m.durationSeconds.p95 >= 0);
  assert.deepEqual(m.review, { aiDrafts: 4, approved: 1, discarded: 1, pendingReview: 2, approvalRate: 0.5, discardRate: 0.5, ruleChosenOverAi: 0 });
});

test("metrics are content-free, admin-only and tenant-scoped", async () => {
  const r = await call(metrics.GET, { as: A, url: "/api/admin/ai-metrics" });
  const text = JSON.stringify(r.json);
  for (const f of facts) assert.ok(!text.includes(f), "no fact text");
  assert.ok(!text.includes("tok-SECRET"));
  assert.equal((await call(metrics.GET, { as: CM, url: "/api/admin/ai-metrics" })).status, 403);
  assert.equal((await call(metrics.GET, { as: DEMO_USERS.auditor, url: "/api/admin/ai-metrics" })).status, 403);
  assert.equal((await call(metrics.GET, { url: "/api/admin/ai-metrics" })).status, 401);
  const other = await call(metrics.GET, { as: DEMO_USERS.otherAdmin, url: "/api/admin/ai-metrics" });
  assert.equal(other.status, 200);
  assert.equal(other.json.jobs.requested, 0, "another tenant sees none of these jobs");
  assert.equal(other.json.review.aiDrafts, 0);
  assert.equal((await call(metrics.GET, { as: A, url: "/api/admin/ai-metrics?days=0" })).status, 400);
  assert.equal((await call(metrics.GET, { as: A, url: "/api/admin/ai-metrics?days=1;DROP" })).status, 400);
});
