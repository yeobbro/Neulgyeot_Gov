import { route } from "@/lib/server/http";
import { submitAssessment } from "@/lib/server/services/cases";

export const POST = route<{ id: string; aid: string }>(async ({ params, tx, actor }) => submitAssessment(tx, actor, params.id, params.aid));
