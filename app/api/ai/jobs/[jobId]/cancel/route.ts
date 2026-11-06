import { route } from "@/lib/server/http";
import { cancelJob } from "@/lib/server/ai/jobs";

export const POST = route<{ jobId: string }>(async ({ params, tx, actor }) => cancelJob(tx, actor, params.jobId));
