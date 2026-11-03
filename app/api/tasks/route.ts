import { parseQuery, route } from "@/lib/server/http";
import { listTasks, taskListQuery } from "@/lib/server/services/followup";

export const GET = route(async ({ req, tx, actor }) => ({ data: await listTasks(tx, actor, parseQuery(req, taskListQuery)) }));
