import { parseBody, route } from "@/lib/server/http";
import { getWearableOverview, registerDevice, registerDeviceBody } from "@/lib/server/services/wearables";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => getWearableOverview(tx, actor, params.id));
export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => registerDevice(tx, actor, params.id, await parseBody(req, registerDeviceBody)));
