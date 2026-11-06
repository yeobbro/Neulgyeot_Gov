/**
 * Asynchronous AI draft jobs. Executed only by the internal worker (lib/server/ai/worker.ts, scripts/ai-worker.mts);
 * no public HTTP endpoint runs a job.
 *
 * Lifecycle (status):
 *   pending ──claim──▶ processing ──AI draft verified──▶ completed   (new ai_drafts row in the same group, status 'draft')
 *      ▲                  │  ├─network / 503 & attempts left──▶ pending (next_attempt_at = backoff)     [ai.job.retry]
 *      │                  │  ├─circuit open──▶ pending, attempt refunded, retried after the cooldown       [ai.job.defer]
 *      │                  │  ├─worker shutting down──▶ pending, attempt refunded                           [ai.job.release]
 *      │                  │  └─anything else / attempts exhausted / too old──▶ failed (rule draft stays usable)
 *      └── lease expired ─┘ (reclaimed by another worker while attempts remain)
 *   pending | processing ──cancel──▶ cancelled (a running worker's late result is discarded)
 *
 * Transactions: every DB step is a SHORT withTenant() transaction (RLS on). The provider call happens between
 * them with no transaction open. Results are stored only if the job is still `processing` under the same lease
 * (owner AND attempt number) and the group still has no approved draft. Nothing here selects or approves:
 * AI output becomes a new `draft` that a person compares, selects and approves through the review workflow.
 */
import { randomUUID } from "node:crypto";
import { renderDraft, type DraftContent, type Fact } from "../../domain/ai-draft";
import { loadActor, type Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead } from "../authz";
import { withTenant, type Db } from "../db/client";
import { newId } from "../db/ids";
import { AppError, conflict, invalid, notFound } from "../errors";
import { assertDraftReview, buildDraft, type DraftKind } from "../services/ai";
import { getReferral } from "../services/referrals";
import { composeDraft, KNOWN_PROVIDER_CODES, type AIProvider, type ComposedDraft } from "./provider";

export type JobStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";
export type AiJob = {
  id: string; tenant_id: string; draft_id: string; job_type: "draft_compose"; status: JobStatus;
  attempt_count: number; max_attempts: number; requested_by: string; idempotency_key: string;
  next_attempt_at: string | Date; lease_owner: string | null; lease_expires_at: string | Date | null;
  created_at: string | Date; started_at: string | Date | null; completed_at: string | Date | null; failed_at: string | Date | null;
  cancelled_at: string | Date | null; cancelled_by: string | null; error_code: string | null; error_message_safe: string | null; engine: string | null;
  model_version: string | null; prompt_version: string | null; ai_request_id: string | null; result_draft_id: string | null;
};

/**
 * Rescheduled with backoff (consumes an attempt): network errors and HTTP 503 only (after the client's own
 * single in-request retry). An open circuit is DEFERRED without consuming an attempt (no call was made).
 * Everything else fails the job immediately; the rule draft remains usable and a person may request again.
 */
export const RETRYABLE = new Set(["network", "unavailable"]);
export const DEFERRABLE = new Set(["circuit_open"]);
/** A job that cannot finish within this window fails as `job_expired` (bounds deferrals during long outages). */
export const JOB_MAX_AGE_HOURS = 24;

/** Fixed messages: error text from providers is never stored or shown (it could echo input or tokens). */
const SAFE_MESSAGE: Record<string, string> = {
  network: "AI 서비스에 연결할 수 없습니다.", server_error: "AI 서비스 오류가 발생했습니다.", unavailable: "AI 서비스가 일시적으로 사용할 수 없습니다.",
  circuit_open: "AI 서비스가 일시 중단되어 잠시 후 다시 시도합니다.", timeout: "AI 응답 시간이 초과되었습니다.", job_timeout: "AI 작업 시간이 초과되었습니다.",
  invalid_response: "AI 응답 형식이 올바르지 않습니다.", all_ai_sentences_rejected: "AI 문장이 근거 검증을 통과하지 못했습니다.",
  final_verification_failed: "AI 초안이 최종 검증을 통과하지 못했습니다.", no_sendable_facts: "AI로 보낼 수 있는 사실이 없습니다.",
  ai_disabled: "AI 제공자가 설정되어 있지 않습니다.", ai_disabled_for_tenant: "이 기관은 AI 초안 사용이 꺼져 있습니다.",
  real_data_blocked: "실제 개인정보는 AI로 보내지 않습니다(합성 데이터만 허용).", no_tenant_token: "이 기관의 AI 연결 정보가 없습니다.",
  lease_expired: "작업 처리 시간이 초과되어 중단되었습니다.", draft_not_reviewable: "원본 초안이 이미 처리되었습니다.",
  attempts_exhausted: "재시도 한도를 초과했습니다.", requester_not_permitted: "요청자에게 더 이상 이 초안을 처리할 권한이 없습니다.",
  job_expired: "작업이 너무 오래 대기하여 종료되었습니다.", provider_error: "AI 작업이 완료되지 않았습니다. 규칙 기반 초안을 사용하세요.",
};
const JOB_CODES = new Set(Object.keys(SAFE_MESSAGE));
/** Only codes Gov defines (job codes + known provider codes) are stored; anything else becomes `provider_error`. */
const safeCode = (code: string | null | undefined) => (code && (JOB_CODES.has(code) || KNOWN_PROVIDER_CODES.has(code)) ? code : "provider_error");
const safeMessage = (code: string) => SAFE_MESSAGE[code] ?? SAFE_MESSAGE.provider_error;
const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 600);

type DraftRow = {
  id: string; case_id: string | null; referral_id: string | null; kind: DraftKind; engine: string; status: string;
  content: DraftContent & { facts: Fact[] }; created_by: string; draft_group_id: string;
};
const DRAFT_COLS = `id, case_id, referral_id, kind, engine, status, content, created_by, draft_group_id`;

const tenantAiEnabled = async (tx: Db, tenantId: string) =>
  Boolean((await tx.query<{ ai_enabled: boolean }>(`SELECT ai_enabled FROM tenant_settings WHERE tenant_id = $1`, [tenantId]))[0]?.ai_enabled);
const groupHasApproved = async (tx: Db, groupId: string) =>
  (await tx.query(`SELECT 1 FROM ai_drafts WHERE draft_group_id = $1 AND status = 'approved'`, [groupId])).length > 0;

/** "synthetic" only if the tenant AND (for case drafts) the care recipient are flagged synthetic. Never guessed. */
async function dataClassFor(tx: Db, tenantId: string, d: { case_id: string | null; referral_id: string | null }): Promise<"synthetic" | "real"> {
  const [t] = await tx.query<{ is_synthetic: boolean }>(`SELECT is_synthetic FROM tenants WHERE id = $1`, [tenantId]);
  if (!t?.is_synthetic) return "real";
  // the person behind the draft: the case's recipient, or — for a referral already linked to a case — that recipient
  const caseId = d.case_id ?? (d.referral_id
    ? (await tx.query<{ case_id: string | null }>(`SELECT case_id FROM incoming_referrals WHERE id = $1`, [d.referral_id]))[0]?.case_id ?? null
    : null);
  if (caseId) {
    const [r] = await tx.query<{ is_synthetic: boolean }>(
      `SELECT r.is_synthetic FROM care_cases c JOIN care_recipients r ON r.id = c.recipient_id WHERE c.id = $1`, [caseId]);
    if (!r?.is_synthetic) return "real";
  }
  return "synthetic";
}

/* ------------------------------------------------------------------------------------------------ enqueue */
/**
 * Called inside a request transaction (route()). Requires: tenant AI switch on, WRITE permission on the draft's
 * target, the draft is the ROOT rule draft of its group, unreviewed, and nothing in the group is approved.
 * Idempotent per (tenant, key); at most one active job per draft (DB-enforced). Duplicates return the existing job.
 */
export async function enqueueDraftJob(tx: Db, actor: Actor, b: { draftId: string; idempotencyKey: string; maxAttempts?: number }) {
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(b.idempotencyKey)) throw invalid("Idempotency-Key 형식이 올바르지 않습니다.");
  const [d] = await tx.query<DraftRow>(`SELECT ${DRAFT_COLS} FROM ai_drafts WHERE id = $1 FOR UPDATE`, [b.draftId]);
  if (!d) throw notFound("초안");
  await assertDraftReview(tx, actor, d, "approve");
  const existing = async () => {
    const [byKey] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE idempotency_key = $1`, [b.idempotencyKey]);
    if (byKey) {
      if (byKey.draft_id !== d.id) throw conflict("같은 요청 키가 다른 초안에 사용되었습니다.");
      return byKey;
    }
    return (await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE draft_id = $1 AND job_type = 'draft_compose' AND status IN ('pending','processing')`, [d.id]))[0];
  };
  const found = await existing();
  if (found) return { job: found, created: false };
  if (!(await tenantAiEnabled(tx, actor.tenantId))) throw conflict("이 기관은 AI 초안 사용이 꺼져 있습니다. 규칙 기반 초안을 사용하세요.");
  if (d.engine !== "rules" || d.draft_group_id !== d.id || d.status !== "draft") throw conflict("검토 전 규칙 기반 초안에만 AI 제안을 요청할 수 있습니다.");
  if (await groupHasApproved(tx, d.draft_group_id)) throw conflict("이미 승인된 초안이 있습니다.");
  const id = newId("aij");
  // ON CONFLICT covers both unique keys (idempotency key, one active job per draft) under concurrency → no 500
  const [job] = await tx.query<AiJob>(
    `INSERT INTO ai_jobs (id, tenant_id, draft_id, job_type, requested_by, idempotency_key, max_attempts)
     VALUES ($1,$2,$3,'draft_compose',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,
    [id, actor.tenantId, d.id, actor.id, b.idempotencyKey, Math.min(Math.max(b.maxAttempts ?? 3, 1), 5)],
  );
  if (!job) {
    const raced = await existing();
    if (raced) return { job: raced, created: false };
    throw conflict("AI 작업을 만들 수 없습니다. 잠시 후 다시 시도하세요.");
  }
  await audit(tx, actor, "ai.job.enqueue", { type: "ai_job", id }, "success", { draft: d.id, kind: d.kind });
  return { job, created: true };
}

/* ------------------------------------------------------------------------------------------------ claim */
/**
 * Short transaction: atomically takes due jobs of ONE tenant. `FOR UPDATE SKIP LOCKED` + the status/lease
 * predicate means two workers can never hold the same job; an expired lease can be taken over while attempts
 * remain (attempt_count is incremented on every claim and doubles as the lease token). Jobs whose lease
 * expired with no attempts left fail.
 */
export async function claimJobs(db: Db, o: { tenantId: string; workerId: string; limit?: number; leaseSeconds?: number }): Promise<AiJob[]> {
  return withTenant(db, o.tenantId, async (tx) => {
    const exhausted = await tx.query<{ id: string }>(
      `UPDATE ai_jobs SET status = 'failed', failed_at = now(), error_code = 'lease_expired', error_message_safe = $1, lease_owner = NULL, lease_expires_at = NULL
        WHERE status = 'processing' AND lease_expires_at < now() AND attempt_count >= max_attempts RETURNING id`,
      [safeMessage("lease_expired")],
    );
    for (const j of exhausted) await audit(tx, null, "ai.job.fail", { type: "ai_job", id: j.id }, "failure", { code: "lease_expired" }, o.tenantId);
    return tx.query<AiJob>(
      `UPDATE ai_jobs SET status = 'processing', lease_owner = $1 || ':' || substr(md5(random()::text || clock_timestamp()::text || id), 1, 12),
              lease_expires_at = now() + make_interval(secs => $2),
              attempt_count = attempt_count + 1, started_at = COALESCE(started_at, now())
        WHERE id IN (
          SELECT id FROM ai_jobs
           WHERE attempt_count < max_attempts
             AND ((status = 'pending' AND next_attempt_at <= now()) OR (status = 'processing' AND lease_expires_at < now()))
           ORDER BY next_attempt_at, created_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [o.workerId, o.leaseSeconds ?? 600, o.limit ?? 1],
    );
  });
}

/* ------------------------------------------------------------------------------------------------ run */
export type RunOutcome = "completed" | "retry_scheduled" | "deferred" | "failed" | "stale";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "job_timeout"> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<"job_timeout">((r) => (t = setTimeout(() => r("job_timeout"), ms)))]).finally(() => clearTimeout(t));
}
/**
 * The lease is ours only if it is the exact lease we claimed: lease_owner = "<workerId>:<random per claim>" and the
 * attempt number match. A re-claim by the same worker id (after a release/deferral) is a different lease.
 */
const ownsLease = (j: AiJob | undefined, job: AiJob, workerId: string) =>
  Boolean(j && j.status === "processing" && job.lease_owner?.startsWith(`${workerId}:`) && j.lease_owner === job.lease_owner && j.attempt_count === job.attempt_count);

type Prepared = { problem: string } | { src: DraftRow; facts: Fact[]; ruleDraft: DraftContent; dataClass: "synthetic" | "real" };

/** Processes one claimed job: read (tx) → provider (no tx) → write (tx, lease-checked). */
export async function runJob(db: Db, job: AiJob, o: { provider: AIProvider | null; workerId: string; jobTimeoutMs?: number }): Promise<RunOutcome> {
  // phase 1 — short transaction: lease, kill switch, age, permissions; FactBook rebuilt NOW as the requester
  const prepared = await withTenant(db, job.tenant_id, async (tx): Promise<Prepared | null> => {
    const [j] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1`, [job.id]);
    if (!ownsLease(j, job, o.workerId)) {
      // lost the lease (taken over / cancelled) before calling the provider: no AI call is made at all
      await audit(tx, null, "ai.job.stale", { type: "ai_job", id: job.id }, "failure", { status: j?.status ?? "missing", phase: "before_call" }, job.tenant_id);
      return null;
    }
    if (Date.now() - new Date(j!.created_at).getTime() > JOB_MAX_AGE_HOURS * 3_600_000) return { problem: "job_expired" };
    if (!(await tenantAiEnabled(tx, job.tenant_id))) return { problem: "ai_disabled_for_tenant" };
    const [src] = await tx.query<DraftRow>(`SELECT ${DRAFT_COLS} FROM ai_drafts WHERE id = $1`, [j!.draft_id]);
    if (!src || src.status !== "draft" || src.engine !== "rules" || (await groupHasApproved(tx, src.draft_group_id))) return { problem: "draft_not_reviewable" };
    const requester = await loadActor(tx, j!.requested_by);
    if (!requester) return { problem: "requester_not_permitted" };
    try {
      // current permission + current consent state, not the snapshot taken when the rule draft was made
      await assertDraftReview(tx, requester, src, "approve");
      const built = await buildDraft(tx, requester, src.kind === "referral_summary" ? { kind: src.kind, referralId: src.referral_id! } : { kind: src.kind, caseId: src.case_id! });
      return { src, facts: built.facts, ruleDraft: built.content, dataClass: await dataClassFor(tx, job.tenant_id, src) };
    } catch (e) {
      if (e instanceof AppError) return { problem: "requester_not_permitted" };
      throw e;
    }
  });
  if (!prepared) return "stale";

  // phase 2 — provider call, NO transaction open
  let composed: ComposedDraft | "job_timeout" | null = null;
  if (!("problem" in prepared)) {
    composed = await withTimeout(
      composeDraft({ provider: o.provider, tenantId: job.tenant_id, kind: prepared.src.kind, facts: prepared.facts, ruleDraft: prepared.ruleDraft, dataClass: prepared.dataClass, traceId: `trc_${job.id}_${job.attempt_count}` }),
      o.jobTimeoutMs ?? 300_000,
    );
  }

  // phase 3 — short write transaction, only if we still own the job
  return withTenant(db, job.tenant_id, async (tx) => {
    const [cur] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1 FOR UPDATE`, [job.id]);
    if (!ownsLease(cur, job, o.workerId)) {
      await audit(tx, null, "ai.job.stale", { type: "ai_job", id: job.id }, "failure", { status: cur?.status ?? "missing", phase: "after_call" }, job.tenant_id);
      return "stale" as const;
    }
    const fail = async (code: string, retry: boolean): Promise<RunOutcome> => {
      const c = safeCode(code);
      if (DEFERRABLE.has(c)) {
        // no call was made: refund the attempt and wait for the breaker cooldown (bounded by JOB_MAX_AGE_HOURS)
        await tx.query(
          `UPDATE ai_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, attempt_count = attempt_count - 1,
                  error_code = $2, error_message_safe = $3, next_attempt_at = now() + interval '30 seconds' WHERE id = $1`,
          [cur.id, c, safeMessage(c)],
        );
        await audit(tx, null, "ai.job.defer", { type: "ai_job", id: cur.id }, "failure", { code: c }, cur.tenant_id);
        return "deferred";
      }
      if (retry && cur.attempt_count < cur.max_attempts) {
        await tx.query(
          `UPDATE ai_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, error_code = $2, error_message_safe = $3,
                  next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [cur.id, c, safeMessage(c), backoffSeconds(cur.attempt_count)],
        );
        await audit(tx, null, "ai.job.retry", { type: "ai_job", id: cur.id }, "failure", { code: c, attempt: cur.attempt_count }, cur.tenant_id);
        return "retry_scheduled";
      }
      const exhausted = retry;
      await tx.query(
        `UPDATE ai_jobs SET status = 'failed', failed_at = now(), lease_owner = NULL, lease_expires_at = NULL, error_code = $2, error_message_safe = $3 WHERE id = $1`,
        [cur.id, c, safeMessage(exhausted ? "attempts_exhausted" : c)],
      );
      await audit(tx, null, "ai.job.fail", { type: "ai_job", id: cur.id }, "failure", { code: c, attempt: cur.attempt_count, exhausted }, cur.tenant_id);
      return "failed";
    };
    if ("problem" in prepared) return fail(prepared.problem, false);
    const [src] = await tx.query<DraftRow>(`SELECT ${DRAFT_COLS} FROM ai_drafts WHERE id = $1 FOR UPDATE`, [cur.draft_id]);
    if (!src || src.status !== "draft" || src.engine !== "rules" || composed === null || (await groupHasApproved(tx, src.draft_group_id))) return fail("draft_not_reviewable", false);
    if (composed === "job_timeout") return fail("job_timeout", false);
    if (composed.engine === "rules") return fail(composed.fallbackReason ?? "provider_error", RETRYABLE.has(composed.fallbackReason ?? ""));

    // store the AI proposal as a NEW draft in the same group; the rule draft stays untouched
    const facts = prepared.facts;
    const newDraftId = newId("aid");
    const content = {
      sections: composed.content.sections, facts, text: renderDraft(composed.content),
      ai: { sectionEngines: composed.sectionEngines, rejected: composed.rejected.length, excludedFacts: composed.excludedFacts.length,
        aiRequestId: composed.aiRequestId, model: composed.model, promptVersion: composed.promptVersion, sourceDraftId: src.id },
    };
    await tx.query(
      `INSERT INTO ai_drafts (id, tenant_id, case_id, referral_id, kind, engine, status, content, created_by, source_job_id, draft_group_id)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10)`,
      [newDraftId, cur.tenant_id, src.case_id, src.referral_id, src.kind, composed.engine, JSON.stringify(content), cur.requested_by, cur.id, src.draft_group_id],
    );
    let si = 0;
    for (const sec of composed.content.sections)
      for (const sen of sec.sentences) {
        si++;
        for (const fid of sen.factIds) {
          const f = facts.find((x) => x.id === fid)!;
          await tx.query(`INSERT INTO ai_source_references (id, tenant_id, draft_id, sentence_index, source_type, source_id, field) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [newId("asr"), cur.tenant_id, newDraftId, si, f.sourceType, f.sourceId, f.field]);
        }
      }
    await tx.query(
      `UPDATE ai_jobs SET status = 'completed', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_message_safe = NULL,
              engine = $2, model_version = $3, prompt_version = $4, ai_request_id = $5, result_draft_id = $6 WHERE id = $1`,
      [cur.id, composed.engine, composed.model, composed.promptVersion, composed.aiRequestId, newDraftId],
    );
    await audit(tx, null, "ai.job.complete", { type: "ai_job", id: cur.id }, "success", { draft: newDraftId, engine: composed.engine, rejected: composed.rejected.length }, cur.tenant_id);
    return "completed" as const;
  });
}

/** Graceful shutdown: hands a claimed job back (attempt refunded) if this worker still owns it. */
export async function releaseJob(db: Db, job: AiJob, workerId: string) {
  return withTenant(db, job.tenant_id, async (tx) => {
    const [cur] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1 FOR UPDATE`, [job.id]);
    if (!ownsLease(cur, job, workerId)) return false;
    await tx.query(
      `UPDATE ai_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, attempt_count = attempt_count - 1, next_attempt_at = now() WHERE id = $1`,
      [job.id],
    );
    await audit(tx, null, "ai.job.release", { type: "ai_job", id: job.id }, "success", { reason: "worker_shutdown" }, job.tenant_id);
    return true;
  });
}

/** One pass over one tenant (used by the worker loop and by tests). */
export async function runWorkerOnce(db: Db, o: { tenantId: string; provider: AIProvider | null; workerId?: string; limit?: number; jobTimeoutMs?: number; leaseSeconds?: number }) {
  const workerId = o.workerId ?? `wk_${randomUUID().slice(0, 8)}`;
  const jobs = await claimJobs(db, { tenantId: o.tenantId, workerId, limit: o.limit ?? 1, leaseSeconds: o.leaseSeconds });
  const out: { id: string; outcome: RunOutcome }[] = [];
  for (const j of jobs) out.push({ id: j.id, outcome: await runJob(db, j, { provider: o.provider, workerId, jobTimeoutMs: o.jobTimeoutMs }) });
  return out;
}

/* ------------------------------------------------------------------------------------------------ cancel / status */
async function draftForJob(tx: Db, j: AiJob) {
  const [d] = await tx.query<{ case_id: string | null; referral_id: string | null; kind: string; status: string }>(`SELECT case_id, referral_id, kind, status FROM ai_drafts WHERE id = $1`, [j.draft_id]);
  if (!d) throw notFound("AI 작업");
  return d;
}

export async function cancelJob(tx: Db, actor: Actor, jobId: string) {
  const [j] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1 FOR UPDATE`, [jobId]);
  if (!j) throw notFound("AI 작업");
  await assertDraftReview(tx, actor, await draftForJob(tx, j), "discard");
  if (j.status !== "pending" && j.status !== "processing") throw conflict("진행 중인 작업만 취소할 수 있습니다.");
  await tx.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [jobId, actor.id]);
  await audit(tx, actor, "ai.job.cancel", { type: "ai_job", id: jobId }, "success", { from: j.status });
  return { status: "cancelled" as const };
}

export type JobView = ReturnType<typeof projectJob>;
function projectJob(j: AiJob, sourceStatus: string, resultStatus: string | null) {
  return {
    id: j.id, status: j.status, engine: j.engine, attempts: j.attempt_count, maxAttempts: j.max_attempts,
    // retryable: the queue will try again by itself; canRequestAgain: a person may enqueue a new job for the same rule draft
    retryable: j.status === "pending" && Boolean(j.error_code),
    canRequestAgain: (j.status === "failed" || j.status === "cancelled") && sourceStatus === "draft",
    error: j.error_code ? { code: j.error_code, message: j.error_message_safe } : null,
    modelVersion: j.model_version, promptVersion: j.prompt_version, sourceDraftId: j.draft_id,
    resultDraftId: j.result_draft_id, resultReviewStatus: resultStatus,
    requestedAt: j.created_at, createdAt: j.created_at, startedAt: j.started_at, completedAt: j.completed_at, failedAt: j.failed_at, cancelledAt: j.cancelled_at,
    nextAttemptAt: j.status === "pending" ? j.next_attempt_at : null,
  };
}

/** Read permission on the draft's single target (same rule as viewing the draft). */
export async function assertDraftRead(tx: Db, actor: Actor, d: { case_id: string | null; referral_id: string | null; kind: string }) {
  if ((d.case_id && d.referral_id) || (d.kind === "referral_summary") !== Boolean(d.referral_id)) throw notFound("초안");
  if (d.case_id) await assertCaseRead(tx, actor, d.case_id);
  else if (d.referral_id) await getReferral(tx, actor, d.referral_id);
  else throw notFound("초안");
}

/** UI-facing projection. Read access to the draft target is required; no content is returned. */
export async function getJobStatus(tx: Db, actor: Actor, jobId: string) {
  const [j] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1`, [jobId]);
  if (!j) throw notFound("AI 작업");
  const d = await draftForJob(tx, j);
  await assertDraftRead(tx, actor, d).catch(() => { throw notFound("AI 작업"); });
  const [r] = j.result_draft_id ? await tx.query<{ status: string }>(`SELECT status FROM ai_drafts WHERE id = $1`, [j.result_draft_id]) : [];
  return projectJob(j, d.status, r?.status ?? null);
}

/** Latest job for a rule draft (caller must have checked read permission). */
export async function latestJobForDraft(tx: Db, draftId: string, sourceStatus: string) {
  const [j] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE draft_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [draftId]);
  if (!j) return null;
  const [r] = j.result_draft_id ? await tx.query<{ status: string }>(`SELECT status FROM ai_drafts WHERE id = $1`, [j.result_draft_id]) : [];
  return projectJob(j, sourceStatus, r?.status ?? null);
}
