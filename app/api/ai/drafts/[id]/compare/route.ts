import { route } from "@/lib/server/http";
import { getDraftGroup } from "@/lib/server/services/ai-review";

/** Rule draft vs AI draft(s) of the same group, with evidence, selection/approval state and the latest job. */
export const GET = route<{ id: string }>(async ({ params, tx, actor }) => getDraftGroup(tx, actor, params.id));
