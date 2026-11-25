/**
 * Optional in-process AI job worker for LOCAL DEMOS only.
 *
 * The production design is a separate worker process (scripts/ai-worker.mts) next to a shared PostgreSQL.
 * For a single-machine demo with the in-memory DEMO database (e.g. a Mac running Ollama), set
 *   AI_INPROCESS_WORKER=true AI_PROVIDER=local_llm LOCAL_LLM_MODEL=qwen2.5:7b
 * and the Next.js server polls the job queue itself. No HTTP endpoint runs jobs.
 *
 * Refused on Vercel/serverless (no long-running process) and in production unless DEMO_MODE=true.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AI_INPROCESS_WORKER !== "true") return;
  const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  if (process.env.VERCEL) return log("inprocess_worker_refused", { reason: "serverless" });
  if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") return log("inprocess_worker_refused", { reason: "production_without_demo_mode" });

  const { providerFromEnv } = await import("./lib/server/ai/provider");
  const { AiWorker } = await import("./lib/server/ai/worker");
  const { getDb } = await import("./lib/server/db/client");
  let provider;
  try {
    provider = providerFromEnv(process.env);
  } catch (e) {
    return log("inprocess_worker_refused", { reason: e instanceof Error ? e.message : "invalid_config" });
  }
  if (!provider) return log("inprocess_worker_refused", { reason: "provider_not_configured" });
  const db = await getDb();
  const worker = new AiWorker({
    db,
    provider,
    workerId: "wk_inprocess",
    pollMs: 3000,
    leaseSeconds: 900,
    jobTimeoutMs: Number(process.env.AI_WORKER_JOB_TIMEOUT_MS ?? 600_000),
    log: (event, data) => log(event, data),
  });
  worker.start();
  const health = await provider.health();
  log("inprocess_worker_started", { provider: provider.name, healthOk: health.ok, reason: health.reason ?? null });
}
