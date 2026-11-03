import { parseBody, route } from "@/lib/server/http";
import { reviewBody, reviewDraft } from "@/lib/server/services/ai";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => reviewDraft(tx, actor, params.id, await parseBody(req, reviewBody)));
