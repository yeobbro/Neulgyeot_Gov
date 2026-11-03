import { route } from "@/lib/server/http";
import { mapData } from "@/lib/server/services/insights";

export const GET = route(async ({ tx, actor }) => mapData(tx, actor));
