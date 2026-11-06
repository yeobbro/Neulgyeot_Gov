/**
 * Async AI jobs against the real schema + RLS (in-memory PGlite, synthetic seed). The AI provider is a local mock:
 * no network, no real model. Nothing here wires a worker or scheduler into the app.
 */
import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import * as review from "../../app/api/ai/drafts/[id]/review/route";
import * as select from "../../app/api/ai/drafts/[id]/select/route";
import { cancelJob, claimJobs, enqueueDraftJob, getJobStatus, runJob, runWorkerOnce, type AiJob } from "../../lib/server/ai/jobs";
import type { ProviderRecord } from "../../lib/server/ai/fact-policy";
import { ProviderUnavailable, type AIProvider, type ProviderDraft } from "../../lib/server/ai/provider";
import { openDb, withTenant, type Db } from "../../lib/server/db/client";
import * as m005 from "../../lib/server/db/migrations/005_ai_jobs";
import * as m006 from "../../lib/server/db/migrations/006_ai_draft_review";
import { AppError } from "../../lib/server/errors";
import { resetRateLimits } from "../../lib/server/http";
import { asActor, call, DEMO_USERS, freshDb } from "../helpers";

const T = "tn_gaon";
const A: string = DEMO_USERS.admin;
const CM: string = DEMO_USERS.cmHaesol; // assigned to ir_2 and case_3
let db: Db;
before(async () => {
  db = await freshDb();
  // the per-tenant AI switch defaults to OFF (seed and schema); these tests exercise the enabled path for tn_gaon only
  await db.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = 'tn_gaon'`);
});
beforeEach(() => resetRateLimits()); // drafts API limits 20/min per user; this file creates many drafts

type Step = "ok" | "network" | "unavailable" | "server_error" | "invalid_response" | "bad_ids" | { hangMs: number };
/** Mock provider. Each call proves no DB transaction is open (PGlite serialises: a query would block on an open tx). */
class MockProvider implements AIProvider {
  readonly name = "ai-intelligence" as const;
  calls = 0;
  inputs: string[] = [];
  constructor(private steps: Step[] = [], private probe?: Db) {}
  async health() {
    return { ok: true };
  }
  async proposeDraft(input: { tenantId: string; sectionTitles: string[]; facts: readonly ProviderRecord[]; traceId: string }): Promise<ProviderDraft> {
    this.calls++;
    this.inputs.push(JSON.stringify(input));
    if (this.probe) {
      const t = setTimeout(() => undefined, 0);
      const r = await Promise.race([this.probe.query(`SELECT 1 AS ok`), new Promise((res) => setTimeout(() => res("blocked"), 1000))]);
      clearTimeout(t);
      assert.notEqual(r, "blocked", "provider ran while a DB transaction was open");
    }
    const step = this.steps.shift() ?? "ok";
    if (typeof step === "object") await new Promise((r) => setTimeout(r, step.hangMs));
    else if (step !== "ok" && step !== "bad_ids") throw new ProviderUnavailable(step, `raw provider detail with secret tok-SECRET-123 and 010-1234-5678`);
    const first = input.facts[0];
    const sentence = step === "bad_ids" ? { text: "근거 없는 문장입니다.", factIds: ["F_unknown"] } : { text: `${first.text} 내용이 확인되었습니다.`, factIds: [first.id] };
    return {
      sections: input.sectionTitles.map((title, i) => ({ title, sentences: i === 0 ? [sentence] : [] })),
      requestId: "req_0123456789abcdef0123", model: "mock-model", promptVersion: "mock-p1", engine: "mock",
    };
  }
}

const ruleDraft = async (as: string = A, body: Record<string, unknown> = { kind: "referral_summary", referralId: "ir_2" }) => {
  const r = await call(drafts.POST, { as, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { id: string; facts: { id: string; text: string }[] };
};
let keySeq = 0;
const key = () => `test-key-${String(++keySeq).padStart(4, "0")}`;
const enqueue = (draftId: string, as: string = CM, idempotencyKey = key(), maxAttempts?: number) =>
  asActor(db, as, (tx, actor) => enqueueDraftJob(tx, actor, { draftId, idempotencyKey, maxAttempts }));
const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
  return "no_error";
};
const job = async (id: string) => (await db.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1`, [id]))[0];
const auditFor = (id: string) => db.query<{ action: string; actor_id: string | null; outcome: string; meta: any; at: Date }>(`SELECT action, actor_id, outcome, meta, at FROM audit_logs WHERE entity_id = $1 ORDER BY at, id`, [id]);
/** Takes every due job off the queue (other tests may leave pending jobs behind). */
const drain = async () => {
  await db.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE status IN ('pending','processing')`);
};

test("migrations 005+006: table, constraints and RLS exist; down/up round-trips on an empty database", async () => {
  const [rls] = await db.query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_jobs'`);
  assert.equal(rls.relrowsecurity, true);
  const grants = await db.query<{ privilege_type: string }>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'ai_jobs' AND grantee = 'neulgyeot_app'`);
  assert.deepEqual(grants.map((g) => g.privilege_type).sort(), ["INSERT", "SELECT", "UPDATE"], "no DELETE for the app role");
  const fresh = await openDb({ url: null });
  // 006 depends on 005 (FK ai_drafts.source_job_id → ai_jobs): roll back in reverse order, re-apply in order
  await fresh.exec(m006.down);
  await fresh.exec(m005.down);
  assert.equal((await fresh.query(`SELECT 1 FROM pg_class WHERE relname = 'ai_jobs'`)).length, 0);
  assert.equal((await fresh.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_drafts' AND column_name IN ('draft_group_id','source_job_id')`)).length, 0);
  await fresh.exec(m005.up);
  await fresh.exec(m006.up);
  assert.equal((await fresh.query(`SELECT 1 FROM pg_class WHERE relname = 'ai_jobs'`)).length, 1);
  assert.equal((await fresh.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_drafts' AND column_name IN ('draft_group_id','selection_status','selected_by','selected_at')`)).length, 4);
});

test("1. create: pending job, ids only — no FactBook text, prompt or note stored", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j, created } = await enqueue(d.id);
  assert.equal(created, true);
  assert.equal(j.status, "pending");
  assert.equal(j.attempt_count, 0);
  assert.equal(j.requested_by, CM);
  const row = JSON.stringify(await job(j.id));
  for (const f of d.facts) assert.ok(!row.includes(f.text), `fact text leaked into ai_jobs: ${f.id}`);
  assert.ok(!row.includes("퇴원 후 식사 준비"), "social worker note");
});

test("permissions: read-only users cannot enqueue; reviewed or AI drafts cannot be re-queued; other tenant gets 404", async () => {
  await drain();
  const d = await ruleDraft();
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [A]);
  try {
    assert.equal(await errCode(enqueue(d.id, CM)), "forbidden");
  } finally {
    await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [CM]);
  }
  for (const who of [DEMO_USERS.cmMaru, DEMO_USERS.auditor, DEMO_USERS.providerNursing, DEMO_USERS.otherAdmin]) assert.equal(await errCode(enqueue(d.id, who)), "not_found", who);
  const approved = await ruleDraft();
  assert.equal((await call(review.POST, { as: CM, params: { id: approved.id }, body: { action: "approve" } })).status, 200);
  assert.equal(await errCode(enqueue(approved.id)), "conflict");
  assert.equal((await db.query(`SELECT 1 FROM ai_jobs WHERE draft_id = ANY($1)`, [[d.id, approved.id]])).length, 0);
});

test("2+3. claim then complete: AI proposal becomes a NEW draft awaiting human review; the rule draft is untouched", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  const claimed = await claimJobs(db, { tenantId: T, workerId: "wk_a", limit: 5 });
  assert.deepEqual(claimed.map((c) => c.id), [j.id]);
  assert.equal(claimed[0].status, "processing");
  assert.equal(claimed[0].lease_owner, "wk_a");
  assert.equal(claimed[0].attempt_count, 1);
  const p = new MockProvider(["ok"], db);
  assert.equal(await runJob(db, claimed[0], { provider: p, workerId: "wk_a" }), "completed");
  assert.equal(p.calls, 1);
  assert.ok(!p.inputs[0].includes("퇴원 후 식사 준비") && !p.inputs[0].includes("소견"), "note never sent");

  const done = await job(j.id);
  assert.equal(done.status, "completed");
  assert.ok(done.completed_at && done.result_draft_id && !done.lease_owner);
  assert.equal(done.ai_request_id, "req_0123456789abcdef0123");
  assert.equal(done.model_version, "mock-model");
  const [nd] = await db.query<{ engine: string; status: string; source_job_id: string; created_by: string; content: any }>(`SELECT engine, status, source_job_id, created_by, content FROM ai_drafts WHERE id = $1`, [done.result_draft_id]);
  assert.ok(["hybrid", "ai-intelligence"].includes(nd.engine));
  assert.equal(nd.status, "draft", "AI output is never auto-approved");
  assert.equal(nd.source_job_id, j.id);
  assert.equal(nd.created_by, CM);
  assert.equal(nd.content.ai.sourceDraftId, d.id);
  assert.ok((await db.query(`SELECT 1 FROM ai_source_references WHERE draft_id = $1`, [done.result_draft_id])).length > 0);
  const [src] = await db.query<{ status: string; engine: string }>(`SELECT status, engine FROM ai_drafts WHERE id = $1`, [d.id]);
  assert.deepEqual(src, { status: "draft", engine: "rules" });

  const st = await asActor(db, CM, (tx, actor) => getJobStatus(tx, actor, j.id));
  assert.equal(st.status, "completed");
  assert.equal(st.resultReviewStatus, "draft");
  assert.equal(st.error, null);
  assert.ok(!JSON.stringify(st).includes(d.facts[0].text), "status projection carries no content");
  // the existing human approval flow (with its permission check) applies to the AI draft
  assert.equal((await call(review.POST, { as: DEMO_USERS.cmMaru, params: { id: done.result_draft_id! }, body: { action: "approve" } })).status, 404);
  // two drafts now compete in the group: approval needs an explicit selection first (selection ≠ approval)
  assert.equal((await call(review.POST, { as: CM, params: { id: done.result_draft_id! }, body: { action: "approve" } })).status, 409);
  assert.equal((await call(select.POST, { as: CM, params: { id: done.result_draft_id! }, body: { action: "select" } })).status, 200);
  assert.equal((await call(review.POST, { as: CM, params: { id: done.result_draft_id! }, body: { action: "approve" } })).status, 200);
  assert.equal((await asActor(db, CM, (tx, actor) => getJobStatus(tx, actor, j.id))).resultReviewStatus, "approved");
  assert.equal(await errCode(enqueue(done.result_draft_id!)), "conflict", "AI drafts are not re-queued");
});

test("4. failure: non-retryable provider error → failed with a fixed safe message; provider detail never stored", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  const out = await runWorkerOnce(db, { tenantId: T, workerId: "wk_f", provider: new MockProvider(["invalid_response"]) });
  assert.deepEqual(out, [{ id: j.id, outcome: "failed" }]);
  const f = await job(j.id);
  assert.equal(f.status, "failed");
  assert.equal(f.error_code, "invalid_response");
  assert.equal(f.error_message_safe, "AI 응답 형식이 올바르지 않습니다.");
  const all = JSON.stringify([f, await auditFor(j.id)]);
  assert.ok(!all.includes("tok-SECRET") && !all.includes("010-1234"), "no token or PII in job row or audit");
  assert.equal((await db.query(`SELECT 1 FROM ai_drafts WHERE source_job_id = $1`, [j.id])).length, 0);
  const st = await asActor(db, CM, (tx, actor) => getJobStatus(tx, actor, j.id));
  assert.equal(st.retryable, false);
  assert.equal(st.canRequestAgain, true, "rule draft still usable; a person may ask again");
  const again = await enqueue(d.id);
  assert.equal(again.created, true, "a failed job does not block a new request");
  await drain();
});

test("5. retry: only network errors and 503 are rescheduled with backoff; 500 fails at once; attempts are capped", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id, CM, key(), 3);
  const p = new MockProvider(["network", "unavailable", "ok"]);
  assert.deepEqual(await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: p }), [{ id: j.id, outcome: "retry_scheduled" }]);
  let r = await job(j.id);
  assert.equal(r.status, "pending");
  assert.equal(r.error_code, "network");
  assert.ok(new Date(r.next_attempt_at).getTime() > Date.now(), "backoff scheduled in the future");
  assert.equal((await asActor(db, CM, (tx, actor) => getJobStatus(tx, actor, j.id))).retryable, true);
  assert.deepEqual(await claimJobs(db, { tenantId: T, workerId: "wk_r" }), [], "not claimable before backoff");
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [j.id]);
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: p }))[0].outcome, "retry_scheduled");
  assert.equal((await job(j.id)).error_code, "unavailable");
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [j.id]);
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: p }))[0].outcome, "completed");
  r = await job(j.id);
  assert.equal(r.attempt_count, 3);
  assert.equal(r.error_code, null);

  const d2 = await ruleDraft();
  const { job: j2 } = await enqueue(d2.id, CM, key(), 2);
  const p2 = new MockProvider(["network", "network"]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: p2 });
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [j2.id]);
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: p2 }))[0].outcome, "failed");
  const x = await job(j2.id);
  assert.equal(x.status, "failed");
  assert.equal(x.attempt_count, 2);
  assert.equal(x.error_message_safe, "재시도 한도를 초과했습니다.");

  const d3 = await ruleDraft();
  const { job: j3 } = await enqueue(d3.id);
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_r", provider: new MockProvider(["server_error"]) }))[0].outcome, "failed");
  assert.equal((await job(j3.id)).attempt_count, 1, "HTTP 500 is not retried by the queue");
});

test("6. duplicate requests: same key or same draft returns the existing job; DB enforces one active job per draft", async () => {
  await drain();
  const d = await ruleDraft();
  const k = key();
  const a = await enqueue(d.id, CM, k);
  const b = await enqueue(d.id, A, k);
  const c = await enqueue(d.id, CM, key());
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(c.created, false);
  assert.equal(b.job.id, a.job.id);
  assert.equal(c.job.id, a.job.id);
  const other = await ruleDraft();
  assert.equal(await errCode(enqueue(other.id, CM, k)), "conflict", "a key cannot be reused for another draft");
  // concurrent requests
  const d2 = await ruleDraft();
  const many = await Promise.all([0, 1, 2, 3].map(() => enqueue(d2.id, CM, key()).catch((e) => e)));
  assert.equal(new Set(many.filter((m) => !(m instanceof Error)).map((m: any) => m.job.id)).size, 1);
  assert.equal((await db.query(`SELECT 1 FROM ai_jobs WHERE draft_id = $1`, [d2.id])).length, 1);
  // the partial unique index rejects a second active job even if application checks were bypassed
  await assert.rejects(
    db.query(`INSERT INTO ai_jobs (id, tenant_id, draft_id, job_type, requested_by, idempotency_key) VALUES ('aij_dup', $1, $2, 'draft_compose', $3, 'raw-dup-key-1')`, [T, d.id, CM]),
    /ai_jobs_one_active_per_draft|unique/i,
  );
});

test("7. duplicate workers: one claim per job; an expired lease is taken over and the slow worker's result is discarded", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  const [w1, w2] = await Promise.all([claimJobs(db, { tenantId: T, workerId: "wk_1", limit: 5 }), claimJobs(db, { tenantId: T, workerId: "wk_2", limit: 5 })]);
  assert.equal(w1.length + w2.length, 1, "exactly one worker owns the job");
  const mine = [...w1, ...w2][0];
  const owner = mine.lease_owner!;
  const otherWorker = owner === "wk_1" ? "wk_2" : "wk_1";
  assert.equal(await runJob(db, mine, { provider: new MockProvider(), workerId: otherWorker }), "stale", "a non-owner cannot process it");

  // the owner stalls; its lease expires; another worker takes over
  await db.query(`UPDATE ai_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [j.id]);
  const taken = await claimJobs(db, { tenantId: T, workerId: "wk_3" });
  assert.equal(taken[0].id, j.id);
  assert.equal(taken[0].attempt_count, 2);
  const late = new MockProvider();
  assert.equal(await runJob(db, mine, { provider: late, workerId: owner }), "stale");
  assert.equal(late.calls, 0, "a worker that lost its lease does not call the provider");
  assert.equal(await runJob(db, taken[0], { provider: new MockProvider(), workerId: "wk_3" }), "completed");
  assert.equal((await db.query(`SELECT 1 FROM ai_drafts WHERE source_job_id = $1`, [j.id])).length, 1, "only one AI draft stored");
  assert.ok((await auditFor(j.id)).some((a) => a.action === "ai.job.stale" && a.meta.phase === "before_call"));

  // a lease that expires on the last attempt fails the job instead of looping
  const d2 = await ruleDraft();
  const { job: j2 } = await enqueue(d2.id, CM, key(), 1);
  await claimJobs(db, { tenantId: T, workerId: "wk_4" });
  await db.query(`UPDATE ai_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [j2.id]);
  assert.deepEqual(await claimJobs(db, { tenantId: T, workerId: "wk_5" }), []);
  assert.equal((await job(j2.id)).error_code, "lease_expired");
});

test("8. tenant isolation: RLS hides jobs from other tenants; workers only see their tenant; no cross-tenant writes", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  assert.deepEqual(await withTenant(db, "tn_nuri", (tx) => tx.query(`SELECT id FROM ai_jobs`)), []);
  assert.deepEqual(await withTenant(db, "tn_nuri", (tx) => tx.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING id`, [j.id])), []);
  assert.deepEqual(await claimJobs(db, { tenantId: "tn_nuri", workerId: "wk_n" }), []);
  assert.equal(await errCode(asActor(db, DEMO_USERS.otherAdmin, (tx, actor) => getJobStatus(tx, actor, j.id))), "not_found");
  assert.equal(await errCode(asActor(db, DEMO_USERS.otherAdmin, (tx, actor) => cancelJob(tx, actor, j.id))), "not_found");
  await assert.rejects(
    withTenant(db, "tn_nuri", (tx) => tx.query(`INSERT INTO ai_jobs (id, tenant_id, draft_id, job_type, requested_by, idempotency_key) VALUES ('aij_x', $1, $2, 'draft_compose', $3, 'cross-tenant-1')`, [T, d.id, CM])),
    /row-level security|violates/i,
  );
  assert.deepEqual(await withTenant(db, "", (tx) => tx.query(`SELECT id FROM ai_jobs`)), [], "no tenant context → nothing (fail closed)");
  assert.equal((await job(j.id)).status, "pending");
});

test("9. cancel: pending jobs are never run; a job cancelled mid-flight has its result discarded; permissions apply", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  assert.equal(await errCode(asActor(db, DEMO_USERS.auditor, (tx, actor) => cancelJob(tx, actor, j.id))), "not_found");
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [A]);
  try {
    assert.equal(await errCode(asActor(db, CM, (tx, actor) => cancelJob(tx, actor, j.id))), "forbidden", "read-only cannot cancel");
  } finally {
    await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [CM]);
  }
  assert.deepEqual(await asActor(db, CM, (tx, actor) => cancelJob(tx, actor, j.id)), { status: "cancelled" });
  const c = await job(j.id);
  assert.equal(c.cancelled_by, CM);
  assert.ok(c.cancelled_at);
  assert.deepEqual(await claimJobs(db, { tenantId: T, workerId: "wk_c" }), []);
  assert.equal(await errCode(asActor(db, CM, (tx, actor) => cancelJob(tx, actor, j.id))), "conflict");

  const d2 = await ruleDraft();
  const { job: j2 } = await enqueue(d2.id);
  const [claimed] = await claimJobs(db, { tenantId: T, workerId: "wk_c" });
  // cancel while the provider is "thinking"
  const slow = new MockProvider([{ hangMs: 50 }]);
  const run = runJob(db, claimed, { provider: slow, workerId: "wk_c" });
  await new Promise((r) => setTimeout(r, 10));
  await asActor(db, A, (tx, actor) => cancelJob(tx, actor, j2.id));
  assert.equal(await run, "stale");
  assert.equal((await job(j2.id)).status, "cancelled");
  assert.equal(slow.calls, 1);
  assert.equal((await db.query(`SELECT 1 FROM ai_drafts WHERE source_job_id = $1`, [j2.id])).length, 0);
  assert.ok((await auditFor(j2.id)).some((a) => a.action === "ai.job.stale" && a.meta.phase === "after_call"));
});

test("10. timeout: a job that exceeds its time budget fails with job_timeout and stores nothing", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  const out = await runWorkerOnce(db, { tenantId: T, workerId: "wk_t", provider: new MockProvider([{ hangMs: 300 }]), jobTimeoutMs: 30 });
  assert.deepEqual(out, [{ id: j.id, outcome: "failed" }]);
  const t = await job(j.id);
  assert.equal(t.error_code, "job_timeout");
  assert.equal(t.error_message_safe, "AI 작업 시간이 초과되었습니다.");
  await new Promise((r) => setTimeout(r, 320)); // let the late provider answer arrive: it must change nothing
  assert.equal((await job(j.id)).status, "failed");
  assert.equal((await db.query(`SELECT 1 FROM ai_drafts WHERE source_job_id = $1`, [j.id])).length, 0);
});

test("11. rule fallback: no provider, or every AI sentence rejected → job fails, rule draft stays usable and approvable", async () => {
  await drain();
  for (const [provider, code] of [[null, "ai_disabled"], [new MockProvider(["bad_ids"]), "all_ai_sentences_rejected"]] as const) {
    const d = await ruleDraft();
    const { job: j } = await enqueue(d.id);
    await runWorkerOnce(db, { tenantId: T, workerId: "wk_fb", provider });
    const f = await job(j.id);
    assert.equal(f.status, "failed");
    assert.equal(f.error_code, code);
    assert.equal((await db.query(`SELECT 1 FROM ai_drafts WHERE source_job_id = $1`, [j.id])).length, 0);
    assert.equal((await call(review.POST, { as: CM, params: { id: d.id }, body: { action: "approve" } })).status, 200, "rule draft approvable");
  }
  // a source draft reviewed while the job waited is not overwritten
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  assert.equal((await call(review.POST, { as: CM, params: { id: d.id }, body: { action: "discard" } })).status, 200);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_fb", provider: new MockProvider() });
  assert.equal((await job(j.id)).error_code, "draft_not_reviewable");
});

test("12. audit: enqueue / retry / complete / fail / cancel / stale recorded with actor, target and time — no content", async () => {
  await drain();
  const d = await ruleDraft();
  const { job: j } = await enqueue(d.id);
  const p = new MockProvider(["network", "ok"]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_au", provider: p });
  await db.query(`UPDATE ai_jobs SET next_attempt_at = now() WHERE id = $1`, [j.id]);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_au", provider: p });
  const rows = await auditFor(j.id);
  assert.deepEqual(rows.map((r) => r.action), ["ai.job.enqueue", "ai.job.retry", "ai.job.complete"]);
  assert.equal(rows[0].actor_id, CM);
  assert.equal(rows[0].meta.draft, d.id);
  assert.equal(rows[1].actor_id, null, "system actions have no user actor");
  assert.equal(rows[1].meta.code, "network");
  assert.ok(rows.every((r) => r.at));
  const d2 = await ruleDraft();
  const { job: j2 } = await enqueue(d2.id);
  await asActor(db, A, (tx, actor) => cancelJob(tx, actor, j2.id));
  const c = await auditFor(j2.id);
  assert.equal(c.at(-1)!.action, "ai.job.cancel");
  assert.equal(c.at(-1)!.actor_id, A);
  const d3 = await ruleDraft();
  const { job: j3 } = await enqueue(d3.id);
  await runWorkerOnce(db, { tenantId: T, workerId: "wk_au", provider: new MockProvider(["invalid_response"]) });
  assert.equal((await auditFor(j3.id)).at(-1)!.action, "ai.job.fail");
  const all = JSON.stringify(await db.query(`SELECT meta FROM audit_logs WHERE action LIKE 'ai.job.%'`));
  for (const f of d.facts) assert.ok(!all.includes(f.text), "no fact text in audit meta");
  assert.ok(!all.includes("tok-SECRET"));
});

test("case drafts work the same way (case write permission)", async () => {
  await drain();
  const d = await ruleDraft(CM, { kind: "meeting_brief", caseId: "case_3" });
  await db.query(`UPDATE case_assignments SET ended_at = now() WHERE case_id = 'case_3' AND user_id = $1`, [CM]);
  try {
    assert.equal(await errCode(enqueue(d.id, CM)), "forbidden");
  } finally {
    await db.query(`UPDATE case_assignments SET ended_at = NULL WHERE case_id = 'case_3' AND user_id = $1`, [CM]);
  }
  const { job: j } = await enqueue(d.id, CM);
  assert.equal((await runWorkerOnce(db, { tenantId: T, workerId: "wk_case", provider: new MockProvider() }))[0].outcome, "completed");
  assert.equal((await job(j.id)).status, "completed");
});
