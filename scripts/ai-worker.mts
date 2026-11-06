/**
 * Standalone AI job worker. NOT deployed or scheduled by this repository; run it only where an approved AI
 * Intelligence server and database are available (see docs/AI_PRODUCTION_READINESS.md).
 *
 *   AI_WORKER_ENABLED=true DATABASE_URL=... AI_PROVIDER=ai_intelligence AI_INTELLIGENCE_URL=https://... \
 *   AI_INTELLIGENCE_TENANT_TOKENS='{"tn_x":"..."}' npx tsx scripts/ai-worker.mts
 *
 * Optional: AI_WORKER_ID, AI_WORKER_POLL_MS (5000), AI_WORKER_LEASE_SECONDS (600), AI_WORKER_JOB_TIMEOUT_MS (300000),
 * AI_WORKER_SHUTDOWN_GRACE_MS (30000), AI_WORKER_HEALTH_PORT (health JSON on 127.0.0.1 only).
 * Logs are JSON lines with ids, codes and counts only — never content, tokens or connection strings.
 */
import { createServer } from "node:http";
import { openDb } from "../lib/server/db/client";
import { providerFromEnv } from "../lib/server/ai/provider";
import { AiWorker } from "../lib/server/ai/worker";

const env = process.env;
const fail = (msg: string) => {
  console.error(JSON.stringify({ event: "refuse_start", reason: msg }));
  process.exit(1);
};
if (env.AI_WORKER_ENABLED !== "true") fail("AI_WORKER_ENABLED is not 'true'");
if (!env.DATABASE_URL) fail("DATABASE_URL is required (the in-memory demo database cannot be shared with the app)");
let provider;
try {
  provider = providerFromEnv(env);
} catch (e) {
  fail(e instanceof Error ? e.message : "invalid provider configuration"); // messages never include token values
}
if (!provider) fail("AI provider not configured (AI_PROVIDER=ai_intelligence and AI_INTELLIGENCE_URL)");
const num = (v: string | undefined, d: number, min: number, max: number) => Math.min(Math.max(Number(v ?? d) || d, min), max);

const db = await openDb({ migrate: false }); // schema changes are applied by the release process, never by the worker
const worker = new AiWorker({
  db, provider: provider!, workerId: env.AI_WORKER_ID,
  pollMs: num(env.AI_WORKER_POLL_MS, 5000, 500, 600_000),
  leaseSeconds: num(env.AI_WORKER_LEASE_SECONDS, 600, 30, 3600),
  jobTimeoutMs: num(env.AI_WORKER_JOB_TIMEOUT_MS, 300_000, 1000, 1_800_000),
  log: (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data })),
});
const lease = num(env.AI_WORKER_LEASE_SECONDS, 600, 30, 3600) * 1000;
const jobTimeout = num(env.AI_WORKER_JOB_TIMEOUT_MS, 300_000, 1000, 1_800_000);
if (lease <= jobTimeout) fail("AI_WORKER_LEASE_SECONDS must exceed the job timeout, otherwise another worker could take over a running job");
worker.start();

let health: ReturnType<typeof createServer> | null = null;
if (env.AI_WORKER_HEALTH_PORT) {
  health = createServer((req, res) => {
    const h = worker.health();
    res.writeHead(req.url === "/healthz" ? (h.status === "ok" ? 200 : 503) : 404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(req.url === "/healthz" ? JSON.stringify(h) : "{}");
  }).listen(Number(env.AI_WORKER_HEALTH_PORT), "127.0.0.1");
}

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "signal", signal }));
  await worker.stop(num(env.AI_WORKER_SHUTDOWN_GRACE_MS, 30_000, 0, 600_000));
  health?.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
