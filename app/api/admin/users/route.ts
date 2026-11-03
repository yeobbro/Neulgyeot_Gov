import { route } from "@/lib/server/http";
import { listUsers } from "@/lib/server/services/admin";

export const GET = route(async ({ tx, actor }) => ({ data: await listUsers(tx, actor) }));
