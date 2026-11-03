import { z } from "zod";
import { parseBody, route } from "@/lib/server/http";
import { completeTask } from "@/lib/server/services/followup";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => completeTask(tx, actor, params.id, (await parseBody(req, z.object({ status: z.enum(["done", "canceled"]) }))).status));
