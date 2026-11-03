import { getDb } from "@/lib/server/db/client";
import { clientKey, errorResponse, json, rateLimit } from "@/lib/server/http";
import { authenticateClient, resubmitReferral } from "@/lib/server/services/integration";

export async function POST(req: Request, ctx: { params: Promise<{ transferId: string }> }) {
  try {
    rateLimit(`integ:${clientKey(req)}`, 60, 60_000);
    const db = await getDb();
    const client = await authenticateClient(db, req.headers.get("authorization"), "referrals:write");
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {}
    const out = await resubmitReferral(db, client, (await ctx.params).transferId, body, req.headers.get("idempotency-key"));
    return json(out.body, out.status);
  } catch (e) {
    return errorResponse(e);
  }
}
