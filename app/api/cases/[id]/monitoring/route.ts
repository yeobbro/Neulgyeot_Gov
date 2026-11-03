import { parseBody, route } from "@/lib/server/http";
import { createMonitoring, listMonitoring, monitoringBody } from "@/lib/server/services/followup";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => ({ data: await listMonitoring(tx, actor, params.id) }));
export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => createMonitoring(tx, actor, params.id, await parseBody(req, monitoringBody)));
