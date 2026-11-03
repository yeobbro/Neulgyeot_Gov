import { parseBody, route } from "@/lib/server/http";
import { planTransitionBody, transitionPlan } from "@/lib/server/services/plans";

export const POST = route<{ id: string; planId: string }>(async ({ req, params, tx, actor }) => transitionPlan(tx, actor, params.id, params.planId, await parseBody(req, planTransitionBody)));
