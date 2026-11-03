import { parseBody, route } from "@/lib/server/http";
import { getSettings, settingsBody, updateSettings } from "@/lib/server/services/admin";

export const GET = route(async ({ tx, actor }) => getSettings(tx, actor));
export const PUT = route(async ({ req, tx, actor }) => updateSettings(tx, actor, await parseBody(req, settingsBody)));
