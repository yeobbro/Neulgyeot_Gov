import { parseBody, route } from "@/lib/server/http";
import { dispatchUpdateBody, updateDispatch } from "@/lib/server/services/control";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => updateDispatch(tx, actor, params.id, await parseBody(req, dispatchUpdateBody)));
