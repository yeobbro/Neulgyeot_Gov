/**
 * AI worker lifecycle with a local mock provider (in-memory PGlite, synthetic seed). No network, no scheduler.
 * Also covers the job-hardening checks from the PR self-review (real data, kill switch, permissions, codes).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, beforeEach, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import { enqueueDraftJob, runWorkerOnce, type AiJob } from "../../lib/server/ai/jobs";
import { AiWorker, listAiEnabledTenants } from "../../lib/server/ai/worker";
import type { Db } from "../../lib/server/db/client";
import { resetRateLimits } from "../../lib/server/http";
import { MockProvider, type MockStep } from "../ai-mock";
import { asActor, call, DEMO_USERS, freshDb } from "../helpers";

const T = "tn_gaon";
const CM: string = DEMO_USERS.cmHaesol;
const A: string = DEMO_USERS.admin;
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

async function newJob(maxAttempts?: number, body: Record<string, unknown> = { kind: "referral_summary", referralId: "ir_2" }) {
  const r = await call(drafts.POST, { as: CM, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const { job } = await asActor(db, CM, (tx, actor) => enqueueDraftJob(tx, actor, { draftId: r.json.id, idempotencyKey: `worker-test-${++seq}`, maxAttempts }));
  return job;
}
const job = async (id: string) => (await db.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1`, [id]))[0];
const aiDraftsFor = async (id: string) => (await db.query(`SELECT 1 FROM ai_drafts WHERE source_job_id = $1`, [id])).length;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await wait(20);
  }
  throw new Error("condition not met in time");
};

test("tenant list: only tenants whose AI switch is on (ids only)", async () => {
  assert.deepEqual(await listAiEnabledTenants(db), ["tn_gaon"]);
});

test("lifecycle: start → processes queued jobs → health ok → graceful stop", async () => {
  const jobs = [await newJob(), await newJob(), await newJob()];
  const p = new MockProvider();
  const events: string[] = [];
  const w = new AiWorker({ db, provider: p, workerId: "wk_life", pollMs: 20, log: (e, d) => events.push(`${e}:${JSON.stringify(d)}`) });
  assert.equal(w.health().state, "idle");
  w.start();
  await until(async () => (await Promise.all(jobs.map((j) => job(j.id)))).every((j) => j.status === "completed"));
  const h = w.health();
  assert.equal(h.status, "ok");
  assert.equal(h.counters.completed, 3);
  assert.equal(h.inFlight, 0);
  await w.stop(1000);
  assert.equal(w.health().state, "stopped");
  assert.equal(p.calls, 3);
  for (const j of jobs) assert.equal(await aiDraftsFor(j.id), 1);
  assert.ok(events.some((e) => e.startsWith("start:")) && events.some((e) => e.startsWith("stopped:")));
  assert.ok(!events.join("\n").includes("퇴원"), "logs carry ids and codes only");
});

test("multiple worker instances never process the same job twice", async () => {
  const jobs = await Promise.all([0, 1, 2, 3, 4, 5].map(() => newJob()));
  const providers = [new MockProvider(), new MockProvider(), new MockProvider()];
  const workers = providers.map((p, i) => new AiWorker({ db, provider: p, workerId: `wk_multi_${i}`, pollMs: 10, perTenantLimit: 2 }));
  await Promise.all(workers.map((w) => w.tick()));
  await Promise.all(workers.map((w) => w.tick()));
  await Promise.all(workers.map((w) => w.tick()));
  const st = await Promise.all(jobs.map((j) => job(j.id)));
  assert.ok(st.every((j) => j.status === "completed"), st.map((j) => j.status).join(","));
  assert.equal(providers.reduce((n, p) => n + p.calls, 0), jobs.length, "exactly one provider call per job");
  for (const j of jobs) assert.equal(await aiDraftsFor(j.id), 1);
  assert.ok(st.every((j) => j.attempt_count === 1));
});

test("graceful shutdown: a running job is handed back (attempt refunded) and the late result is discarded", async () => {
  const j = await newJob();
  const slow = new MockProvider([{ hangMs: 300 }]);
  const w = new AiWorker({ db, provider: slow, workerId: "wk_stop", pollMs: 10 });
  w.start();
  await until(async () => (await job(j.id)).status === "processing");
  await until(async () => slow.calls === 1);
  await w.stop(20); // shorter than the provider call
  const r = await job(j.id);
  assert.equal(r.status, "pending");
  assert.equal(r.attempt_count, 0, "attempt refunded");
  assert.equal(r.lease_owner, null);
  assert.equal(w.health().counters.released, 1);
  await wait(400); // the provider answer arrives after the hand-back
  assert.equal(await aiDraftsFor(j.id), 0, "late result not stored");
  assert.equal((await job(j.id)).status, "pending");
  const acts = (await db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY at, id`, [j.id])).map((x) => x.action);
  assert.ok(acts.includes("ai.job.release") && acts.includes("ai.job.stale"), acts.join(","));
  // another worker finishes it
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_after", provider: new MockProvider() }))[0].outcome, "completed");
});

test("worker retry and breaker: network → retry with backoff; circuit open → deferred without using an attempt", async () => {
  const j = await newJob(3);
  const w = new AiWorker({ db, provider: new MockProvider(["network", "circuit_open", "ok"] as MockStep[]), workerId: "wk_retry", tenants: async () => [T] });
  await w.tick();
  assert.equal((await job(j.id)).status, "pending");
  assert.equal((await job(j.id)).attempt_count, 1);
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [j.id]);
  await w.tick();
  let r = await job(j.id);
  assert.equal(r.error_code, "circuit_open");
  assert.equal(r.attempt_count, 1, "deferral refunds the attempt");
  assert.ok(new Date(r.next_attempt_at).getTime() > Date.now());
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [j.id]);
  await w.tick();
  r = await job(j.id);
  assert.equal(r.status, "completed");
  assert.deepEqual(w.health().counters.retry_scheduled + w.health().counters.deferred + w.health().counters.completed, 3);
});

test("tick errors are contained: the worker keeps running and reports degraded health", async () => {
  let calls = 0;
  const w = new AiWorker({ db, provider: new MockProvider(), workerId: "wk_err", pollMs: 10, tenants: async () => { calls++; throw new Error("connection to db.internal:5432 failed (password=hunter2)"); } });
  w.start();
  await until(async () => calls >= 3);
  const h = w.health();
  assert.equal(h.status, "degraded");
  assert.equal(h.lastTickError, "Error", "only the error class is kept — no connection details");
  assert.ok(!JSON.stringify(h).includes("hunter2"));
  await w.stop(100);
});

test("the worker refuses to start without a provider", () => {
  assert.throws(() => new AiWorker({ db, provider: null }).start(), /not configured/);
});

test("job hardening: real data never leaves Gov; tenant switch off; requester lost permission; job too old", async () => {
  const p = new MockProvider();
  // real (non-synthetic) tenant → blocked before any call
  const j1 = await newJob();
  await db.query(`UPDATE tenants SET is_synthetic = false WHERE id = 'tn_gaon'`);
  try {
    await runWorkerOnce(db, { tenantId: T, workerId: "wk_h", provider: p });
  } finally {
    await db.query(`UPDATE tenants SET is_synthetic = true WHERE id = 'tn_gaon'`);
  }
  assert.equal((await job(j1.id)).error_code, "real_data_blocked");
  // real care recipient on a case draft → blocked
  const j2 = await newJob(undefined, { kind: "meeting_brief", caseId: "case_3" });
  await db.query(`UPDATE care_recipients SET is_synthetic = false WHERE id = (SELECT recipient_id FROM care_cases WHERE id = 'case_3')`);
  try {
    await runWorkerOnce(db, { tenantId: T, workerId: "wk_h", provider: p });
  } finally {
    await db.query(`UPDATE care_recipients SET is_synthetic = true WHERE id = (SELECT recipient_id FROM care_cases WHERE id = 'case_3')`);
  }
  assert.equal((await job(j2.id)).error_code, "real_data_blocked");
  // switch turned off after the request
  const j3 = await newJob();
  await db.query(`UPDATE tenant_settings SET ai_enabled = false WHERE tenant_id = 'tn_gaon'`);
  try {
    await runWorkerOnce(db, { tenantId: T, workerId: "wk_h", provider: p });
  } finally {
    await db.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = 'tn_gaon'`);
  }
  assert.equal((await job(j3.id)).error_code, "ai_disabled_for_tenant");
  // requester was unassigned after the request → re-checked at run time
  const j4 = await newJob();
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [A]);
  try {
    await runWorkerOnce(db, { tenantId: T, workerId: "wk_h", provider: p });
  } finally {
    await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [CM]);
  }
  assert.equal((await job(j4.id)).error_code, "requester_not_permitted");
  // too old (bounded deferral)
  const j5 = await newJob();
  await db.query(`UPDATE ai_jobs SET created_at = now() - interval '25 hours' WHERE id = $1`, [j5.id]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_h", provider: p });
  assert.equal((await job(j5.id)).error_code, "job_expired");
  assert.equal(p.calls, 0, "none of these reached the provider");
  for (const j of [j1, j2, j3, j4, j5]) assert.equal((await job(j.id)).status, "failed");
});

test("provider-chosen error codes are never stored (allowlist)", async () => {
  const j = await newJob();
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_code", provider: new MockProvider(["patient_kim_minsu" as MockStep]) });
  const r = await job(j.id);
  assert.equal(r.error_code, "provider_error");
  const audit = JSON.stringify(await db.query(`SELECT meta FROM audit_logs WHERE entity_id = $1`, [j.id]));
  assert.ok(!audit.includes("kim_minsu"));
});

test("worker script refuses to start without explicit enablement, database and provider (no secrets printed)", () => {
  const run = (extra: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/ai-worker.mts"], { env: { PATH: process.env.PATH ?? "", ...extra } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
  const a = run({});
  assert.equal(a.status, 1);
  assert.match(a.stderr, /refuse_start.*AI_WORKER_ENABLED/);
  const b = run({ AI_WORKER_ENABLED: "true" });
  assert.match(b.stderr, /refuse_start.*DATABASE_URL/);
  const c = run({ AI_WORKER_ENABLED: "true", DATABASE_URL: "postgres://u:pw-SECRET@127.0.0.1:1/x", AI_PROVIDER: "ai_intelligence", AI_INTELLIGENCE_URL: "http://ai.example.org", AI_INTELLIGENCE_TENANT_TOKENS: '{"tn_x":"tok-SECRET"}' });
  assert.equal(c.status, 1);
  assert.match(c.stderr, /refuse_start.*https/);
  assert.ok(!(c.stdout + c.stderr).includes("SECRET"));
});
