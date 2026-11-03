import { parseBody, route } from "@/lib/server/http";
import { acceptBody, acceptReferral } from "@/lib/server/services/referrals";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => acceptReferral(tx, actor, params.id, await parseBody(req, acceptBody)));
