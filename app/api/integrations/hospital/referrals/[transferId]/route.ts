import { getDb } from "@/lib/server/db/client";
import { clientKey, errorResponse, json, rateLimit } from "@/lib/server/http";
import { authenticateClient, getReferralStatusForClient } from "@/lib/server/services/integration";

export async function GET(req: Request, ctx: { params: Promise<{ transferId: string }> }) {
  try {
    rateLimit(`integ:${clientKey(req)}`, 120, 60_000);
    const db = await getDb();
    const client = await authenticateClient(db, req.headers.get("authorization"), "referrals:read");
    return json(await getReferralStatusForClient(db, client, (await ctx.params).transferId));
  } catch (e) {
    return errorResponse(e);
  }
}
