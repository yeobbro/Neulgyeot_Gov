import { getDb } from "@/lib/server/db/client";
import { clientKey, errorResponse, json, rateLimit } from "@/lib/server/http";
import { authenticateClient, hospitalStatusCallback } from "@/lib/server/services/integration";

export async function POST(req: Request) {
  try {
    rateLimit(`integ:${clientKey(req)}`, 60, 60_000);
    const db = await getDb();
    const client = await authenticateClient(db, req.headers.get("authorization"), "callbacks:write");
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {}
    const out = await hospitalStatusCallback(db, client, body, req.headers.get("idempotency-key"));
    return json(out.body, out.status);
  } catch (e) {
    return errorResponse(e);
  }
}
