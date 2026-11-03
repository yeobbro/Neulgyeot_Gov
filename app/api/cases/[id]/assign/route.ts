import { parseBody, route } from "@/lib/server/http";
import { assignCase, caseAssignBody } from "@/lib/server/services/cases";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => assignCase(tx, actor, params.id, await parseBody(req, caseAssignBody)));
