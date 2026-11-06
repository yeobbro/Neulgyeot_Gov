/**
 * Internal AI job worker (Option B: a standalone long-running process next to the AI Intelligence server).
 * Not part of the Next.js app: there is NO HTTP endpoint that runs jobs, so an external request can never
 * trigger processing. The worker authenticates to PostgreSQL with its own credentials and to the AI service with
 * per-tenant tokens; every job step runs inside withTenant() (RLS, non-owner role). Only the tenant list
 * (ids with ai_enabled = true) is read with the owner connection.
 *
 * Duplicate execution: several instances may run; claimJobs() uses FOR UPDATE SKIP LOCKED + leases, and results
 * are written only while the lease (owner + attempt) is still held. Graceful shutdown hands unfinished jobs back.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { claimJobs, releaseJob, runJob, type AiJob, type RunOutcome } from "./jobs";
import type { AIProvider } from "./provider";

export type WorkerOptions = {
  db: Db;
  provider: AIProvider | null;
  workerId?: string;
  /** tenants to serve; default: every tenant whose AI switch is on */
  tenants?: () => Promise<string[]>;
  pollMs?: number;
  leaseSeconds?: number;
  jobTimeoutMs?: number;
  /** jobs claimed per tenant per tick (each is processed sequentially by this instance) */
  perTenantLimit?: number;
  /** structured, content-free log line (ids, codes, counts only) */
  log?: (event: string, data: Record<string, string | number | boolean | null>) => void;
};

/** Owner-connection read of tenant ids only (no content). RLS is not FORCEd, so the owner may list them. */
export async function listAiEnabledTenants(db: Db): Promise<string[]> {
  return (await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_settings WHERE ai_enabled = true ORDER BY tenant_id`)).map((r) => r.tenant_id);
}

export class AiWorker {
  readonly workerId: string;
  private state: "idle" | "running" | "stopping" | "stopped" = "idle";
  private inFlight = new Map<string, AiJob>();
  /** claimed by this instance and not finished yet (incl. claimed-but-not-started jobs of the current batch) */
  private claimed = new Map<string, AiJob>();
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private lastTickAt: Date | null = null;
  private lastTickError: string | null = null;
  readonly counters: Record<RunOutcome | "released" | "ticks" | "tick_errors", number> = {
    completed: 0, failed: 0, retry_scheduled: 0, deferred: 0, stale: 0, released: 0, ticks: 0, tick_errors: 0,
  };
  constructor(private o: WorkerOptions) {
    this.workerId = o.workerId ?? `wk_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  /** a method, not a field check: the state changes concurrently (stop() during an awaited tick) */
  private isStopping() {
    return this.state === "stopping" || this.state === "stopped";
  }

  private log(event: string, data: Record<string, string | number | boolean | null> = {}) {
    this.o.log?.(event, { worker: this.workerId, ...data });
  }

  /** One pass: for each tenant claim up to perTenantLimit jobs and process them. Never throws. */
  async tick(): Promise<{ id: string; outcome: RunOutcome }[]> {
    const out: { id: string; outcome: RunOutcome }[] = [];
    this.counters.ticks++;
    try {
      const tenants = await (this.o.tenants ?? (() => listAiEnabledTenants(this.o.db)))();
      for (const tenantId of tenants) {
        if (this.isStopping()) break;
        const jobs = await claimJobs(this.o.db, { tenantId, workerId: this.workerId, limit: this.o.perTenantLimit ?? 1, leaseSeconds: this.o.leaseSeconds });
        for (const job of jobs) this.claimed.set(job.id, job);
        for (const job of jobs) {
          if (this.isStopping()) {
            this.claimed.delete(job.id);
            // claimed but not started: hand it straight back
            if (await releaseJob(this.o.db, job, this.workerId)) this.counters.released++;
            continue;
          }
          this.inFlight.set(job.id, job);
          try {
            const outcome = await runJob(this.o.db, job, { provider: this.o.provider, workerId: this.workerId, jobTimeoutMs: this.o.jobTimeoutMs });
            this.counters[outcome]++;
            out.push({ id: job.id, outcome });
            this.log("job", { job: job.id, tenant: tenantId, outcome, attempt: job.attempt_count });
          } finally {
            this.inFlight.delete(job.id);
            this.claimed.delete(job.id);
          }
        }
      }
      this.lastTickError = null;
    } catch (e) {
      // DB unavailable etc. Only the error class is logged (messages may contain connection details).
      this.counters.tick_errors++;
      this.lastTickError = e instanceof Error ? e.name : "error";
      this.log("tick_error", { error: this.lastTickError });
    }
    this.lastTickAt = new Date();
    return out;
  }

  start() {
    if (this.state !== "idle") throw new Error("worker already started");
    if (!this.o.provider) throw new Error("AI provider is not configured; the worker refuses to start (jobs would only fail).");
    this.state = "running";
    this.log("start", { pollMs: this.o.pollMs ?? 5000 });
    this.loop = (async () => {
      while (this.state === "running") {
        const done = await this.tick();
        if (this.state !== "running") break;
        if (done.length) continue; // more work may be waiting
        await new Promise<void>((r) => {
          const t = setTimeout(r, this.o.pollMs ?? 5000);
          this.wake = () => (clearTimeout(t), r());
        });
        this.wake = null;
      }
    })();
    return this;
  }

  /**
   * Graceful shutdown: stop claiming, give the running job up to `graceMs` to finish, then hand unfinished jobs
   * back (status pending, attempt refunded). A late provider answer for a released job is discarded (lease lost).
   */
  async stop(graceMs = 30_000) {
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.log("stopping", { inFlight: this.inFlight.size });
    this.wake?.();
    const loop = this.loop ?? Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([loop.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), graceMs)))]);
    clearTimeout(timer);
    if (timedOut) {
      // everything this instance still holds: the running job AND claimed-but-not-started jobs of the batch
      for (const job of [...this.claimed.values()]) {
        if (await releaseJob(this.o.db, job, this.workerId)) this.counters.released++;
        this.claimed.delete(job.id);
      }
    }
    this.state = "stopped";
    this.log("stopped", { released: this.counters.released });
  }

  /** Content-free health snapshot for a local health endpoint / process supervisor. */
  health() {
    const breaker = (this.o.provider as { breaker?: { state: string } } | null)?.breaker?.state ?? null;
    const stale = this.lastTickAt ? Date.now() - this.lastTickAt.getTime() > Math.max((this.o.pollMs ?? 5000) * 3, (this.o.jobTimeoutMs ?? 300_000) + 60_000) : this.state === "running";
    const status = this.state === "running" && !this.lastTickError && !stale && breaker !== "open" ? "ok" : this.state === "running" ? "degraded" : this.state;
    return {
      status, workerId: this.workerId, state: this.state, lastTickAt: this.lastTickAt?.toISOString() ?? null, lastTickError: this.lastTickError,
      inFlight: this.inFlight.size, circuitBreaker: breaker, counters: { ...this.counters },
    };
  }
}
