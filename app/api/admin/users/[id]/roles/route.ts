import { parseBody, route } from "@/lib/server/http";
import { setUserRoles, userRolesBody } from "@/lib/server/services/admin";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => setUserRoles(tx, actor, params.id, await parseBody(req, userRolesBody)));
