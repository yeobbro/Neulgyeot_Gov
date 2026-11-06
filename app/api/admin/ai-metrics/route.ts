import { route } from "@/lib/server/http";
import { getAiMetrics } from "@/lib/server/ai/metrics";

/** Admin-only, tenant-scoped, content-free AI operations metrics. */
export const GET = route(async ({ req, tx, actor }) => {
  const d = new URL(req.url).searchParams.get("days");
  return getAiMetrics(tx, actor, { days: d === null ? undefined : Number(d) });
});
