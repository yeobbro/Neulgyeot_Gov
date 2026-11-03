import { parseBody, route } from "@/lib/server/http";
import { createRecord, listRecords, recordBody } from "@/lib/server/services/cases";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => ({ data: await listRecords(tx, actor, params.id) }));
export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => createRecord(tx, actor, params.id, await parseBody(req, recordBody)));
