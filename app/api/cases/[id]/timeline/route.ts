import { route } from "@/lib/server/http";
import { caseTimeline } from "@/lib/server/services/followup";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => ({ data: await caseTimeline(tx, actor, params.id) }));
