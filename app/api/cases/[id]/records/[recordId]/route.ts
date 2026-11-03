import { z } from "zod";
import { parseBody, route } from "@/lib/server/http";
import { deleteRecord, editRecord, recordEditBody } from "@/lib/server/services/cases";

export const PATCH = route<{ id: string; recordId: string }>(async ({ req, params, tx, actor }) => editRecord(tx, actor, params.id, params.recordId, await parseBody(req, recordEditBody)));
export const DELETE = route<{ id: string; recordId: string }>(async ({ req, params, tx, actor }) =>
  deleteRecord(tx, actor, params.id, params.recordId, (await parseBody(req, z.object({ reason: z.string().max(200) }))).reason),
);
