/**
 * AI observability (per tenant, RLS-scoped). Aggregates ONLY ids/codes/timestamps/counts — never draft text,
 * facts, prompts or provider output. Admin-only. Worker-side signals (circuit breaker state, in-flight jobs)
 * come from the worker health endpoint, not from the database.
 */
import type { Actor } from "../auth/session";
import { isAdmin } from "../authz";
import type { Db } from "../db/client";
import { forbidden, invalid } from "../errors";

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export async function getAiMetrics(tx: Db, actor: Actor, o: { days?: number } = {}) {
  if (!isAdmin(actor)) throw forbidden("기관 관리자만 AI 운영 지표를 볼 수 있습니다.");
  const days = o.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw invalid("days는 1–365 사이여야 합니다.");
  const since = `now() - make_interval(days => ${days})`;
  const [j] = await tx.query<Record<string, string | null>>(
    `SELECT count(*)::int AS requested,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'processing')::int AS processing,
            count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE status = 'failed' AND error_code IN ('timeout','job_timeout','lease_expired'))::int AS timed_out,
            COALESCE(sum(GREATEST(attempt_count - 1, 0)), 0)::int AS retries,
            avg(EXTRACT(EPOCH FROM completed_at - started_at)) FILTER (WHERE status = 'completed') AS avg_seconds,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM completed_at - started_at)) FILTER (WHERE status = 'completed') AS p95_seconds
       FROM ai_jobs WHERE created_at >= ${since}`,
  );
  const codes = await tx.query<{ code: string; n: number }>(
    `SELECT error_code AS code, count(*)::int AS n FROM ai_jobs WHERE status = 'failed' AND created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC, 1`,
  );
  const [defer] = await tx.query<{ deferred: number; released: number }>(
    `SELECT count(*) FILTER (WHERE action = 'ai.job.defer')::int AS deferred, count(*) FILTER (WHERE action = 'ai.job.release')::int AS released
       FROM audit_logs WHERE action IN ('ai.job.defer','ai.job.release') AND at >= ${since}`,
  );
  // review outcome of AI proposals and of the groups they belong to
  const [r] = await tx.query<Record<string, number>>(
    `SELECT count(*) FILTER (WHERE d.source_job_id IS NOT NULL)::int AS ai_drafts,
            count(*) FILTER (WHERE d.source_job_id IS NOT NULL AND d.status = 'approved')::int AS ai_approved,
            count(*) FILTER (WHERE d.source_job_id IS NOT NULL AND d.status = 'discarded')::int AS ai_discarded,
            count(*) FILTER (WHERE d.source_job_id IS NULL AND d.status = 'approved'
                             AND EXISTS (SELECT 1 FROM ai_drafts x WHERE x.draft_group_id = d.draft_group_id AND x.source_job_id IS NOT NULL))::int AS rule_chosen_over_ai
       FROM ai_drafts d WHERE d.created_at >= ${since}`,
  );
  const n = (k: string) => Number(j[k] ?? 0);
  const finished = n("completed") + n("failed");
  const reviewed = r.ai_approved + r.ai_discarded;
  return {
    windowDays: days,
    jobs: { requested: n("requested"), pending: n("pending"), processing: n("processing"), completed: n("completed"), failed: n("failed"), cancelled: n("cancelled") },
    successRate: ratio(n("completed"), finished),
    failureRate: ratio(n("failed"), finished),
    /** every failed job leaves the rule draft as the usable result */
    ruleFallbackRate: ratio(n("failed"), finished),
    timeoutRate: ratio(n("timed_out"), finished),
    retries: n("retries"), deferrals: defer.deferred, releasedOnShutdown: defer.released,
    durationSeconds: { avg: j.avg_seconds === null ? null : Math.round(Number(j.avg_seconds) * 10) / 10, p95: j.p95_seconds === null ? null : Math.round(Number(j.p95_seconds) * 10) / 10 },
    failureCodes: codes,
    review: {
      aiDrafts: r.ai_drafts, approved: r.ai_approved, discarded: r.ai_discarded, pendingReview: r.ai_drafts - reviewed,
      approvalRate: ratio(r.ai_approved, reviewed), discardRate: ratio(r.ai_discarded, reviewed), ruleChosenOverAi: r.rule_chosen_over_ai,
    },
  };
}
