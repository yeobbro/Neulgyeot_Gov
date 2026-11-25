import { parseBody, route } from "@/lib/server/http";
import { reviewSignal, reviewSignalBody } from "@/lib/server/services/wearables";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => reviewSignal(tx, actor, params.id, await parseBody(req, reviewSignalBody)));
