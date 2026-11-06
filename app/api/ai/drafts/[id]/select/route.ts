import { z } from "zod";
import { parseBody, route } from "@/lib/server/http";
import { holdGroup, selectDraft } from "@/lib/server/services/ai-review";

const body = z.object({ action: z.enum(["select", "hold"]) });

/** Select the draft to take to approval, or hold (compare later). Selection is NOT approval. */
export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => {
  const b = await parseBody(req, body);
  return b.action === "select" ? selectDraft(tx, actor, params.id) : holdGroup(tx, actor, params.id);
});
