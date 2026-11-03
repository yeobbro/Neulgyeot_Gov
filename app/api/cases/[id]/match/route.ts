import { z } from "zod";
import { parseQuery, route } from "@/lib/server/http";
import { matchForPlanItem } from "@/lib/server/services/providers";

export const GET = route<{ id: string }>(async ({ req, params, tx, actor }) => matchForPlanItem(tx, actor, params.id, parseQuery(req, z.object({ planItemId: z.string().min(3) })).planItemId));
