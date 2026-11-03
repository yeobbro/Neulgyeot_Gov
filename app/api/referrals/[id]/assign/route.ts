import { parseBody, route } from "@/lib/server/http";
import { assignBody, assignReferral } from "@/lib/server/services/referrals";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => assignReferral(tx, actor, params.id, await parseBody(req, assignBody)));
