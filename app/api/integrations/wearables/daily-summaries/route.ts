import { getDb } from "@/lib/server/db/client";
import { clientKey, errorResponse, json, rateLimit } from "@/lib/server/http";
import { authenticateClient } from "@/lib/server/services/integration";
import { receiveDailySummaries, WEARABLE_SCOPE } from "@/lib/server/services/wearables";

/** System-to-system: wearable gateway → municipality, daily summaries only (DEMO contract v0.1, docs/WEARABLE_INTEGRATION.md). */
export async function POST(req: Request) {
  try {
    rateLimit(`integ:${clientKey(req)}`, 120, 60_000);
    const db = await getDb();
    const client = await authenticateClient(db, req.headers.get("authorization"), WEARABLE_SCOPE);
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {}
    const out = await receiveDailySummaries(db, client, body, req.headers.get("x-trace-id"));
    return json(out.body, out.status);
  } catch (e) {
    return errorResponse(e);
  }
}
