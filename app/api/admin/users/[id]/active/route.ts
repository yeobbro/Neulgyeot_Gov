import { parseBody, route } from "@/lib/server/http";
import { setUserActive, userActiveBody } from "@/lib/server/services/admin";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => setUserActive(tx, actor, params.id, await parseBody(req, userActiveBody)));
