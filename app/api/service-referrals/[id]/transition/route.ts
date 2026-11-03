import { parseBody, route } from "@/lib/server/http";
import { serviceTransitionBody, transitionServiceReferral } from "@/lib/server/services/providers";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => transitionServiceReferral(tx, actor, params.id, await parseBody(req, serviceTransitionBody)));
