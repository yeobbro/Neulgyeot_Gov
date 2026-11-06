import { route } from "@/lib/server/http";
import { getJobStatus } from "@/lib/server/ai/jobs";

export const GET = route<{ jobId: string }>(async ({ params, tx, actor }) => getJobStatus(tx, actor, params.jobId));
