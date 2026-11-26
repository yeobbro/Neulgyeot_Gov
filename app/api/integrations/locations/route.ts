import { getDb } from "@/lib/server/db/client";
import { clientKey, errorResponse, json, rateLimit } from "@/lib/server/http";
import { authenticateClient } from "@/lib/server/services/integration";
import { LOCATION_SCOPE, receiveLocations } from "@/lib/server/services/control-intake";

/** System-to-system: current position fixes, accepted only with an active location consent. docs/CONTROL_DASHBOARD.md */
export async function POST(req: Request) {
  try {
    rateLimit(`integ:${clientKey(req)}`, 600, 60_000);
    const db = await getDb();
    const client = await authenticateClient(db, req.headers.get("authorization"), LOCATION_SCOPE);
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {}
    const out = await receiveLocations(db, client, body, req.headers.get("x-trace-id"));
    return json(out.body, out.status);
  } catch (e) {
    return errorResponse(e);
  }
}
