import { route } from "@/lib/server/http";
import { dashboard } from "@/lib/server/services/insights";

export const GET = route(async ({ tx, actor }) => dashboard(tx, actor));
