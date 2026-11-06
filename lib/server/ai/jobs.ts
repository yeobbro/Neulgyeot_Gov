/**
 * Asynchronous AI draft jobs (foundation — not wired to any route or scheduler yet).
 *
 * Lifecycle (status):
 *   pending ──claim──▶ processing ──AI draft verified──▶ completed   (new ai_drafts row, status 'draft')
 *      ▲                  │  ├─retryable error & attempts left──▶ pending (next_attempt_at = backoff)
 *      │                  │  └─non-retryable / attempts exhausted──▶ failed  (rule draft stays usable)
 *      └── lease expired ─┘ (reclaimed by another worker while attempts remain)
 *   pending | processing ──cancel──▶ cancelled (a running worker's late result is discarded)
 *
 * Transactions: every DB step is a SHORT withTenant() transaction (RLS on). The provider call happens between
 * them with no transaction open. Results are stored only if the job is still `processing` under the same
 * lease owner and the source draft is still an unreviewed rule draft. Nothing here approves anything:
 * AI output becomes a new `draft` that a person must review through the existing approve/discard flow.
 */
import { randomUUID } from "node:crypto";
import { renderDraft, type DraftContent, type Fact } from "../../domain/ai-draft";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead } from "../authz";
import { withTenant, type Db } from "../db/client";
import { newId } from "../db/ids";
import { conflict, invalid, notFound } from "../errors";
import { assertDraftReview, type DraftKind } from "../services/ai";
import { getReferral } from "../services/referrals";
import { composeDraft, type AIProvider, type ComposedDraft } from "./provider";

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
 * Rescheduled with backoff: network errors and HTTP 503 only (after the client's own single in-request retry).
 * Timeouts, other 5xx, 4xx, invalid responses, evidence rejections and an open circuit fail the job immediately;
 * the rule draft remains the usable result and a person may request a new job later.
 */
export const RETRYABLE = new Set(["network", "unavailable"]);

/** Fixed messages: error text from providers is never stored or shown (it could echo input or tokens). */
const SAFE_MESSAGE: Record<string, string> = {
  network: "AI 서비스에 연결할 수 없습니다.", server_error: "AI 서비스 오류가 발생했습니다.", unavailable: "AI 서비스가 일시적으로 사용할 수 없습니다.",
  circuit_open: "AI 서비스가 일시 중단되었습니다.", timeout: "AI 응답 시간이 초과되었습니다.", job_timeout: "AI 작업 시간이 초과되었습니다.",
  invalid_response: "AI 응답 형식이 올바르지 않습니다.", all_ai_sentences_rejected: "AI 문장이 근거 검증을 통과하지 못했습니다.",
  all_sentences_rejected: "AI 문장이 근거 검증을 통과하지 못했습니다.", final_verification_failed: "AI 초안이 최종 검증을 통과하지 못했습니다.",
  no_sendable_facts: "AI로 보낼 수 있는 사실이 없습니다.", ai_disabled: "AI 제공자가 설정되어 있지 않습니다.",
  no_tenant_token: "이 기관의 AI 연결 정보가 없습니다.", lease_expired: "작업 처리 시간이 초과되어 중단되었습니다.",
  draft_not_reviewable: "원본 초안이 이미 처리되었습니다.", attempts_exhausted: "재시도 한도를 초과했습니다.",
};
const safeCode = (code: string) => (/^[a-z_]{1,40}$/.test(code) ? code : "provider_error");
const safeMessage = (code: string) => SAFE_MESSAGE[code] ?? "AI 작업이 완료되지 않았습니다. 규칙 기반 초안을 사용하세요.";
const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 600);

type DraftRow = { id: string; case_id: string | null; referral_id: string | null; kind: DraftKind; engine: string; status: string; content: DraftContent & { facts: Fact[] }; created_by: string };

/* ------------------------------------------------------------------------------------------------ enqueue */
/**
 * Called inside a request transaction (route()). Requires WRITE permission on the draft target, because the job
 * sends (allowlisted) facts of that case/referral to an AI provider. Idempotent per (tenant, idempotency key),
 * and at most one active job per draft: duplicates return the existing job.
 */
export async function enqueueDraftJob(tx: Db, actor: Actor, b: { draftId: string; idempotencyKey: string; maxAttempts?: number }) {
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(b.idempotencyKey)) throw invalid("idempotencyKey 형식이 올바르지 않습니다.");
  const [d] = await tx.query<DraftRow>(`SELECT id, case_id, referral_id, kind, engine, status FROM ai_drafts WHERE id = $1 FOR UPDATE`, [b.draftId]);
  if (!d) throw notFound("초안");
  await assertDraftReview(tx, actor, d, "approve");
  const [byKey] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE idempotency_key = $1`, [b.idempotencyKey]);
  if (byKey) {
    if (byKey.draft_id !== d.id) throw conflict("같은 요청 키가 다른 초안에 사용되었습니다.");
    return { job: byKey, created: false };
  }
  const [active] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE draft_id = $1 AND job_type = 'draft_compose' AND status IN ('pending','processing')`, [d.id]);
  if (active) return { job: active, created: false };
  if (d.status !== "draft" || d.engine !== "rules") throw conflict("검토 전 규칙 기반 초안에만 AI 제안을 요청할 수 있습니다.");
  const id = newId("aij");
  const [job] = await tx.query<AiJob>(
    `INSERT INTO ai_jobs (id, tenant_id, draft_id, job_type, requested_by, idempotency_key, max_attempts) VALUES ($1,$2,$3,'draft_compose',$4,$5,$6) RETURNING *`,
    [id, actor.tenantId, d.id, actor.id, b.idempotencyKey, Math.min(Math.max(b.maxAttempts ?? 3, 1), 5)],
  );
  await audit(tx, actor, "ai.job.enqueue", { type: "ai_job", id }, "success", { draft: d.id, kind: d.kind });
  return { job, created: true };
}

/* ------------------------------------------------------------------------------------------------ claim */
/**
 * Short transaction: atomically takes due jobs of ONE tenant. `FOR UPDATE SKIP LOCKED` + the status/lease
 * predicate means two workers can never hold the same job; an expired lease can be taken over while attempts
 * remain (attempt_count is incremented on every claim). Jobs whose lease expired with no attempts left fail.
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
      `UPDATE ai_jobs SET status = 'processing', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
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
export type RunOutcome = "completed" | "retry_scheduled" | "failed" | "stale";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "job_timeout"> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<"job_timeout">((r) => (t = setTimeout(() => r("job_timeout"), ms)))]).finally(() => clearTimeout(t));
}

/** Processes one claimed job: read (tx) → provider (no tx) → write (tx, lease-checked). */
export async function runJob(db: Db, job: AiJob, o: { provider: AIProvider | null; workerId: string; jobTimeoutMs?: number }): Promise<RunOutcome> {
  // phase 1 — short read transaction
  const loaded = await withTenant(db, job.tenant_id, async (tx) => {
    const [j] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1`, [job.id]);
    if (!j || j.status !== "processing" || j.lease_owner !== o.workerId) {
      // lost the lease (taken over / cancelled) before calling the provider: no AI call is made at all
      await audit(tx, null, "ai.job.stale", { type: "ai_job", id: job.id }, "failure", { status: j?.status ?? "missing", phase: "before_call" }, job.tenant_id);
      return null;
    }
    const [d] = await tx.query<DraftRow>(`SELECT id, case_id, referral_id, kind, engine, status, content, created_by FROM ai_drafts WHERE id = $1`, [j.draft_id]);
    return { j, d };
  });
  if (!loaded) return "stale";
  const { d } = loaded;

  // phase 2 — provider call, NO transaction open
  let composed: ComposedDraft | "job_timeout" | null = null;
  if (d && d.status === "draft" && d.engine === "rules") {
    const ruleDraft: DraftContent = { sections: d.content.sections };
    composed = await withTimeout(
      composeDraft({ provider: o.provider, tenantId: job.tenant_id, kind: d.kind, facts: d.content.facts, ruleDraft, traceId: `trc_${job.id}_${job.attempt_count}` }),
      o.jobTimeoutMs ?? 300_000,
    );
  }

  // phase 3 — short write transaction, only if we still own the job
  return withTenant(db, job.tenant_id, async (tx) => {
    const [cur] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1 FOR UPDATE`, [job.id]);
    if (!cur || cur.status !== "processing" || cur.lease_owner !== o.workerId) {
      await audit(tx, null, "ai.job.stale", { type: "ai_job", id: job.id }, "failure", { status: cur?.status ?? "missing", phase: "after_call" }, job.tenant_id);
      return "stale" as const;
    }
    const [src] = await tx.query<DraftRow>(`SELECT id, case_id, referral_id, kind, engine, status, content, created_by FROM ai_drafts WHERE id = $1 FOR UPDATE`, [cur.draft_id]);
    const fail = async (code: string, retry: boolean): Promise<RunOutcome> => {
      const c = safeCode(code);
      if (retry && cur.attempt_count < cur.max_attempts) {
        await tx.query(
          `UPDATE ai_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, error_code = $2, error_message_safe = $3,
                  next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [cur.id, c, safeMessage(c), backoffSeconds(cur.attempt_count)],
        );
        await audit(tx, null, "ai.job.retry", { type: "ai_job", id: cur.id }, "failure", { code: c, attempt: cur.attempt_count }, cur.tenant_id);
        return "retry_scheduled";
      }
      const final = retry ? "attempts_exhausted" : c;
      await tx.query(
        `UPDATE ai_jobs SET status = 'failed', failed_at = now(), lease_owner = NULL, lease_expires_at = NULL, error_code = $2, error_message_safe = $3 WHERE id = $1`,
        [cur.id, final === "attempts_exhausted" ? c : final, safeMessage(final)],
      );
      await audit(tx, null, "ai.job.fail", { type: "ai_job", id: cur.id }, "failure", { code: c, attempt: cur.attempt_count, exhausted: final === "attempts_exhausted" }, cur.tenant_id);
      return "failed";
    };
    if (!src || src.status !== "draft" || src.engine !== "rules" || composed === null) return fail("draft_not_reviewable", false);
    if (composed === "job_timeout") return fail("job_timeout", false);
    if (composed.engine === "rules") return fail(composed.fallbackReason ?? "provider_error", RETRYABLE.has(composed.fallbackReason ?? ""));

    // store the AI proposal as a NEW draft (status 'draft'); the rule draft stays untouched
    const newDraftId = newId("aid");
    const content = {
      sections: composed.content.sections, facts: src.content.facts, text: renderDraft(composed.content),
      ai: { sectionEngines: composed.sectionEngines, rejected: composed.rejected.length, excludedFacts: composed.excludedFacts.length,
        aiRequestId: composed.aiRequestId, model: composed.model, promptVersion: composed.promptVersion, sourceDraftId: src.id },
    };
    await tx.query(
      `INSERT INTO ai_drafts (id, tenant_id, case_id, referral_id, kind, engine, status, content, created_by, source_job_id) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9)`,
      [newDraftId, cur.tenant_id, src.case_id, src.referral_id, src.kind, composed.engine, JSON.stringify(content), cur.requested_by, cur.id],
    );
    let si = 0;
    for (const sec of composed.content.sections)
      for (const sen of sec.sentences) {
        si++;
        for (const fid of sen.factIds) {
          const f = src.content.facts.find((x) => x.id === fid)!;
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

/** One pass over one tenant (for a future scheduler/worker process; nothing calls this in the app today). */
export async function runWorkerOnce(db: Db, o: { tenantId: string; provider: AIProvider | null; workerId?: string; limit?: number; jobTimeoutMs?: number; leaseSeconds?: number }) {
  const workerId = o.workerId ?? `wk_${randomUUID().slice(0, 8)}`;
  const jobs = await claimJobs(db, { tenantId: o.tenantId, workerId, limit: o.limit ?? 1, leaseSeconds: o.leaseSeconds });
  const out: { id: string; outcome: RunOutcome }[] = [];
  for (const j of jobs) out.push({ id: j.id, outcome: await runJob(db, j, { provider: o.provider, workerId, jobTimeoutMs: o.jobTimeoutMs }) });
  return out;
}

/* ------------------------------------------------------------------------------------------------ cancel / status */
export async function cancelJob(tx: Db, actor: Actor, jobId: string) {
  const [j] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1 FOR UPDATE`, [jobId]);
  if (!j) throw notFound("AI 작업");
  const [d] = await tx.query<{ case_id: string | null; referral_id: string | null }>(`SELECT case_id, referral_id FROM ai_drafts WHERE id = $1`, [j.draft_id]);
  if (!d) throw notFound("AI 작업");
  await assertDraftReview(tx, actor, d, "discard");
  if (j.status !== "pending" && j.status !== "processing") throw conflict("진행 중인 작업만 취소할 수 있습니다.");
  await tx.query(`UPDATE ai_jobs SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [jobId, actor.id]);
  await audit(tx, actor, "ai.job.cancel", { type: "ai_job", id: jobId }, "success", { from: j.status });
  return { status: "cancelled" as const };
}

/** UI-facing projection (future API). Read access to the draft target is required; no content is returned. */
export async function getJobStatus(tx: Db, actor: Actor, jobId: string) {
  const [j] = await tx.query<AiJob>(`SELECT * FROM ai_jobs WHERE id = $1`, [jobId]);
  if (!j) throw notFound("AI 작업");
  const [d] = await tx.query<{ case_id: string | null; referral_id: string | null; status: string }>(`SELECT case_id, referral_id, status FROM ai_drafts WHERE id = $1`, [j.draft_id]);
  if (!d) throw notFound("AI 작업");
  if (d.case_id) await assertCaseRead(tx, actor, d.case_id);
  else if (d.referral_id) await getReferral(tx, actor, d.referral_id);
  else throw notFound("AI 작업");
  const [r] = j.result_draft_id ? await tx.query<{ status: string }>(`SELECT status FROM ai_drafts WHERE id = $1`, [j.result_draft_id]) : [];
  return {
    id: j.id, status: j.status, engine: j.engine, attempts: j.attempt_count, maxAttempts: j.max_attempts,
    // retryable: the queue will try again by itself; canRequestAgain: a person may enqueue a new job for the same rule draft
    retryable: j.status === "pending" && j.attempt_count > 0 && j.attempt_count < j.max_attempts,
    canRequestAgain: (j.status === "failed" || j.status === "cancelled") && d.status === "draft",
    error: j.error_code ? { code: j.error_code, message: j.error_message_safe } : null,
    modelVersion: j.model_version, promptVersion: j.prompt_version, sourceDraftId: j.draft_id,
    resultDraftId: j.result_draft_id, resultReviewStatus: r?.status ?? null,
    createdAt: j.created_at, startedAt: j.started_at, completedAt: j.completed_at, failedAt: j.failed_at, cancelledAt: j.cancelled_at,
  };
}
