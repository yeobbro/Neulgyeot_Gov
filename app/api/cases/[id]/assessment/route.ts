import { parseBody, route } from "@/lib/server/http";
import { assessmentSaveBody, getAssessment, saveAssessment } from "@/lib/server/services/cases";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => getAssessment(tx, actor, params.id));
export const PUT = route<{ id: string }>(async ({ req, params, tx, actor }) => saveAssessment(tx, actor, params.id, await parseBody(req, assessmentSaveBody)));
