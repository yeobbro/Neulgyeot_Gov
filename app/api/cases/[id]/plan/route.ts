import { parseBody, route } from "@/lib/server/http";
import { getPlans, planSaveBody, savePlan } from "@/lib/server/services/plans";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => getPlans(tx, actor, params.id));
export const PUT = route<{ id: string }>(async ({ req, params, tx, actor }) => savePlan(tx, actor, params.id, await parseBody(req, planSaveBody)));
