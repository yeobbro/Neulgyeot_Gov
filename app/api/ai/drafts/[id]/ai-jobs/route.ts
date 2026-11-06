import { invalid } from "@/lib/server/errors";
import { route } from "@/lib/server/http";
import { enqueueDraftJob } from "@/lib/server/ai/jobs";

/**
 * Requests an AI proposal for a rule draft. Only queues a job (no AI call here); refused unless the tenant's AI
 * switch is on. Requires an Idempotency-Key header so retries of the same click never create a second job.
 */
export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => {
  const key = req.headers.get("idempotency-key");
  if (!key) throw invalid("Idempotency-Key 헤더가 필요합니다.");
  const { job, created } = await enqueueDraftJob(tx, actor, { draftId: params.id, idempotencyKey: key });
  return { jobId: job.id, status: job.status, created };
});
