import { storageMode } from "@/lib/server/db/client";
import { json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
/** Liveness + storage mode. No secrets or data. */
export async function GET() {
  const mode = storageMode();
  let db = "unknown";
  try {
    const { getDb } = await import("@/lib/server/db/client");
    const d = await getDb();
    await d.query("SELECT 1");
    db = "ok";
  } catch {
    db = "error";
  }
  return json({ status: db === "ok" ? "ok" : "degraded", db, storage: { kind: mode.kind, persistent: mode.persistent }, demoMode: process.env.DEMO_MODE === "true" || !mode.persistent, aiFeatureEnabled: process.env.AI_FEATURE_ENABLED === "true", version: "0.1.0" }, db === "ok" ? 200 : 503);
}
