import { getDb } from "@/lib/server/db/client";
import { clientKey, errorResponse, json, rateLimit } from "@/lib/server/http";
import { authenticateClient, receiveReferral } from "@/lib/server/services/integration";

/** System-to-system: hospital → municipality discharge-care referral (DEMO contract v1.0). */
export async function POST(req: Request) {
  try {
    rateLimit(`integ:${clientKey(req)}`, 60, 60_000);
    const db = await getDb();
    const client = await authenticateClient(db, req.headers.get("authorization"), "referrals:write");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const out = await receiveReferral(db, client, body, req.headers.get("idempotency-key"), req.headers.get("x-trace-id"));
    return json(out.body, out.status, out.replayed ? { "idempotent-replayed": "true" } : {});
  } catch (e) {
    return errorResponse(e);
  }
}
