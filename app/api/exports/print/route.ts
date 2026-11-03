import { z } from "zod";
import { parseBody, route } from "@/lib/server/http";
import { logExport } from "@/lib/server/services/insights";
import { isStaff } from "@/lib/server/authz";
import { forbidden } from "@/lib/server/errors";

/** Records a print/PDF export event (the page itself is printed by the browser). */
export const POST = route(async ({ req, tx, actor }) => {
  if (!isStaff(actor)) throw forbidden();
  const b = await parseBody(req, z.object({ type: z.enum(["report", "case_summary", "meeting_brief"]), rows: z.number().int().min(0).max(100000), personal: z.boolean() }));
  await logExport(tx, actor, b.type, b.rows, b.personal, {}, "print");
  return { ok: true };
});
