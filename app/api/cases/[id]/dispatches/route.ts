import { parseBody, route } from "@/lib/server/http";
import { dispatchBody, requestDispatch } from "@/lib/server/services/control";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => requestDispatch(tx, actor, params.id, await parseBody(req, dispatchBody)));
