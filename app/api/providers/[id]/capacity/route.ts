import { parseBody, route } from "@/lib/server/http";
import { capacityBody, updateCapacity } from "@/lib/server/services/providers";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => updateCapacity(tx, actor, params.id, await parseBody(req, capacityBody)));
