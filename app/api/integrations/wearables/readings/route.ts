import { getDb } from "@/lib/server/db/client";
import { clientKey, errorResponse, json, rateLimit } from "@/lib/server/http";
import { authenticateClient } from "@/lib/server/services/integration";
import { receiveReadings } from "@/lib/server/services/control-intake";
import { WEARABLE_SCOPE } from "@/lib/server/services/wearables";

/** System-to-system: near-real-time readings (heart rate, temperature, SpO2, fall/SOS events). docs/CONTROL_DASHBOARD.md */
export async function POST(req: Request) {
  try {
    rateLimit(`integ:${clientKey(req)}`, 600, 60_000);
    const db = await getDb();
    const client = await authenticateClient(db, req.headers.get("authorization"), WEARABLE_SCOPE);
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {}
    const out = await receiveReadings(db, client, body, req.headers.get("x-trace-id"));
    return json(out.body, out.status);
  } catch (e) {
    return errorResponse(e);
  }
}
