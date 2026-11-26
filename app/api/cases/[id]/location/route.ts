import { parseBody, route } from "@/lib/server/http";
import { designatedBody, getLocationSettings, setDesignatedLocation } from "@/lib/server/services/control";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => getLocationSettings(tx, actor, params.id));
export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => setDesignatedLocation(tx, actor, params.id, await parseBody(req, designatedBody)));
