/**
 * AI job queue + worker on real PostgreSQL (pooled connections): exactly-once across instances and OS processes,
 * lease-expiry recovery, retry/backoff, graceful shutdown. The AI service is a local contract-conformant stub
 * (synthetic data, no model, no external network).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { claimJobs, enqueueDraftJob, runJob, runWorkerOnce, type AiJob } from "../../lib/server/ai/jobs";
import { AiWorker } from "../../lib/server/ai/worker";
import { withTenant, type Db } from "../../lib/server/db/client";
import { loadActor } from "../../lib/server/auth/session";
import { seed } from "../../lib/server/db/seed";
import { resetRateLimits } from "../../lib/server/http";
import { generateDraft } from "../../lib/server/services/ai";
import { MockProvider, type MockStep } from "../ai-mock";
import { createTestDb, SKIP, type TestDb } from "./pg-helpers";

const T = "tn_gaon";
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
});
after(async () => {
  if (!SKIP) await t.drop();
});
beforeEach(async () => {
  if (SKIP) return;
  await db.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE status IN ('pending','processing')`);
});

async function newJobs(n: number, maxAttempts?: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    resetRateLimits();
    ids.push(await withTenant(db, T, async (tx) => {
      const a = (await loadActor(tx, "usr_gaon_cm1"))!;
      const d = await generateDraft(tx, a, i % 2 ? { kind: "meeting_brief", caseId: "case_3" } : { kind: "referral_summary", referralId: "ir_2" });
      return (await enqueueDraftJob(tx, a, { draftId: d.id, idempotencyKey: `pg-worker-${++seq}`, maxAttempts })).job.id;
    }));
  }
  return ids;
}
const jobsById = async (ids: string[]) => db.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = ANY($1) ORDER BY id`, [ids]);
const resultDrafts = async (ids: string[]) => (await db.query<{ n: number; d: number }>(
  `SELECT count(*)::int AS n, count(DISTINCT source_job_id)::int AS d FROM ai_drafts WHERE source_job_id = ANY($1)`, [ids]))[0];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await wait(100);
  }
  throw new Error("timeout waiting for condition");
};

test("4 in-process workers on a shared pool: every job processed exactly once", { skip: SKIP }, async () => {
  const ids = await newJobs(16);
  const providers = Array.from({ length: 4 }, () => new MockProvider(Array.from({ length: 16 }, () => ({ hangMs: 40 }) as MockStep)));
  const workers = providers.map((p, i) => new AiWorker({ db, provider: p, workerId: `wk_pool_${i}`, pollMs: 20, perTenantLimit: 2, tenants: async () => [T] }).start());
  await until(async () => (await jobsById(ids)).every((j) => j.status === "completed"), 30_000);
  await Promise.all(workers.map((w) => w.stop(2000)));
  const js = await jobsById(ids);
  assert.ok(js.every((j) => j.attempt_count === 1), js.map((j) => j.attempt_count).join(","));
  assert.equal(providers.reduce((n, p) => n + p.calls, 0), 16, "one provider call per job");
  assert.deepEqual(await resultDrafts(ids), { n: 16, d: 16 });
  assert.ok(workers.filter((w) => w.health().counters.completed > 0).length >= 2, "work was actually shared");
});

test("lease expiry: a crashed worker's job is taken over after the lease; the old lease can no longer write", { skip: SKIP }, async () => {
  const [id] = await newJobs(1);
  const [crashed] = await claimJobs(db, { tenantId: T, workerId: "wk_crash", leaseSeconds: 1 }); // claims, then "dies"
  assert.equal(crashed.id, id);
  assert.deepEqual(await claimJobs(db, { tenantId: T, workerId: "wk_rescue" }), [], "not claimable while the lease is valid");
  await wait(1300);
  const out = await runWorkerOnce(db, { tenantId: T, workerId: "wk_rescue", provider: new MockProvider() });
  assert.deepEqual(out.map((o) => o.outcome), ["completed"]);
  const late = new MockProvider();
  assert.equal(await runJob(db, crashed, { provider: late, workerId: "wk_crash" }), "stale");
  assert.equal(late.calls, 0);
  const [j] = await jobsById([id]);
  assert.equal(j.attempt_count, 2);
  assert.deepEqual(await resultDrafts([id]), { n: 1, d: 1 });
});

test("retry: network and 503 back off and succeed; non-retryable errors fail once; attempts are capped", { skip: SKIP }, async () => {
  // one job per scenario: claims are ordered by next_attempt_at, so queued siblings would be picked first
  const [a] = await newJobs(1, 2);
  const flaky = new MockProvider(["network", "ok"]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: flaky });
  let [ja] = await jobsById([a]);
  assert.equal(ja.status, "pending");
  assert.ok(new Date(ja.next_attempt_at).getTime() > Date.now());
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [a]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: flaky });
  [ja] = await jobsById([a]);
  assert.deepEqual([ja.status, ja.attempt_count], ["completed", 2]);

  const [b] = await newJobs(1, 2);
  const down = new MockProvider(["unavailable", "unavailable"]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: down });
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [b]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: down });
  const [jb] = await jobsById([b]);
  assert.deepEqual([jb.status, jb.attempt_count, jb.error_message_safe], ["failed", 2, "재시도 한도를 초과했습니다."]);

  const [c] = await newJobs(1, 2);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: new MockProvider(["server_error"]) });
  const [jc] = await jobsById([c]);
  assert.deepEqual([jc.status, jc.attempt_count, jc.error_code], ["failed", 1, "server_error"]);
  const acts = (await db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE entity_id = ANY($1)`, [[a, b, c]])).map((r) => r.action);
  assert.ok(acts.filter((x) => x === "ai.job.retry").length >= 2 && acts.includes("ai.job.complete") && acts.filter((x) => x === "ai.job.fail").length === 2);
});

/* ---------------------------------------------------------------- separate OS processes (scripts/ai-worker.mts) */
let stub: Server | null = null;
function startStub(latencyMs: number): Promise<number> {
  return new Promise((resolve) => {
    let n = 0;
    stub = createServer((req, res) => {
      let b = "";
      req.on("data", (ch) => (b += ch));
      req.on("end", () => setTimeout(() => {
        const trace = String(req.headers["x-request-id"] ?? "");
        const body = JSON.parse(b || "{}");
        const first = body.records?.[0];
        n++;
        res.writeHead(200, { "content-type": "application/json", "x-request-id": trace });
        res.end(JSON.stringify({ request_id: `req_${String(n).padStart(20, "0")}`, trace_id: trace, status: "ok", reason: null, engine: "stub", model: "stub-model", prompt_version: "stub-p1",
          sections: (body.sections ?? []).map((title: string, i: number) => ({ title, sentences: i === 0 && first ? [{ text: `${first.text} 내용이 확인되었습니다.`, source_ids: [first.id] }] : [] })), requires_human_review: true }));
      }, latencyMs));
    }).listen(0, "127.0.0.1", () => resolve((stub!.address() as { port: number }).port));
  });
}

test("3 worker OS processes against PostgreSQL + contract stub: exactly once, graceful SIGTERM, no secrets in logs", { skip: SKIP, timeout: 120_000 }, async () => {
  const ids = await newJobs(12);
  const port = await startStub(150);
  const procs: { p: ChildProcess; out: string[] }[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const out: string[] = [];
      const p = spawn(process.execPath, ["--import", "tsx", "scripts/ai-worker.mts"], {
        env: {
          PATH: process.env.PATH ?? "", AI_WORKER_ENABLED: "true", DATABASE_URL: t.url, DATABASE_POOL_MAX: "3",
          AI_PROVIDER: "ai_intelligence", AI_INTELLIGENCE_URL: `http://127.0.0.1:${port}`, AI_INTELLIGENCE_TENANT_TOKENS: JSON.stringify({ tn_gaon: "tok-SECRET-stub" }),
          AI_WORKER_ID: `wk_proc_${i}`, AI_WORKER_POLL_MS: "500", AI_WORKER_LEASE_SECONDS: "60", AI_WORKER_JOB_TIMEOUT_MS: "30000",
        } as unknown as NodeJS.ProcessEnv,
      });
      p.stdout!.on("data", (d) => out.push(String(d)));
      p.stderr!.on("data", (d) => out.push(String(d)));
      procs.push({ p, out });
    }
    await until(async () => (await jobsById(ids)).every((j) => j.status === "completed"), 90_000);
  } finally {
    const exits = procs.map(({ p }) => new Promise<number | null>((r) => p.on("exit", (code) => r(code))));
    for (const { p } of procs) p.kill("SIGTERM");
    const codes = await Promise.all(exits);
    stub?.close();
    assert.deepEqual(codes, [0, 0, 0], "graceful exit on SIGTERM");
  }
  const js = await jobsById(ids);
  assert.ok(js.every((j) => j.attempt_count === 1));
  assert.deepEqual(await resultDrafts(ids), { n: 12, d: 12 });
  const owners = new Set(js.map((j) => j.lease_owner === null ? "released" : "held"));
  assert.deepEqual([...owners], ["released"]);
  const logs = procs.map((x) => x.out.join("")).join("\n");
  const perProc = procs.map((x) => (x.out.join("").match(/"outcome":"completed"/g) ?? []).length);
  assert.equal(perProc.reduce((a, b) => a + b, 0), 12, `per process: ${perProc.join("/")}`);
  assert.ok(!logs.includes("tok-SECRET") && !logs.includes("test-owner-local-only"), "no token or DB password in logs");
  assert.ok(logs.includes('"event":"stopped"'));
});
