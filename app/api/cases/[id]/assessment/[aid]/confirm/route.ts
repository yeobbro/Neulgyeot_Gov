import { route } from "@/lib/server/http";
import { confirmAssessment } from "@/lib/server/services/cases";

export const POST = route<{ id: string; aid: string }>(async ({ params, tx, actor }) => confirmAssessment(tx, actor, params.id, params.aid));
