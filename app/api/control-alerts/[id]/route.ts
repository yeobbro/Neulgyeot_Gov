import { parseBody, route } from "@/lib/server/http";
import { alertUpdateBody, updateAlert } from "@/lib/server/services/control";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => updateAlert(tx, actor, params.id, await parseBody(req, alertUpdateBody)));
