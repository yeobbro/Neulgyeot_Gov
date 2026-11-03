import { route } from "@/lib/server/http";
import { providerInbox } from "@/lib/server/services/providers";

export const GET = route(async ({ tx, actor }) => ({ data: await providerInbox(tx, actor) }));
