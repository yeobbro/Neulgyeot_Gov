import { parseBody, route } from "@/lib/server/http";
import { caseTransitionBody, changeCaseStatus } from "@/lib/server/services/cases";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => changeCaseStatus(tx, actor, params.id, await parseBody(req, caseTransitionBody)));
