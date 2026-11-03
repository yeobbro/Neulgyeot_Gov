import { parseBody, route } from "@/lib/server/http";
import { referralTransitionBody, transitionReferral } from "@/lib/server/services/referrals";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => transitionReferral(tx, actor, params.id, await parseBody(req, referralTransitionBody)));
