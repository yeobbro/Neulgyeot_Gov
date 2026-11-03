import { applyMigrations } from "./migrate";

/**
 * Minimal DB interface with two implementations:
 *  - `pg` against Managed PostgreSQL (DATABASE_URL) — persistent, for deployments.
 *  - PGlite (PostgreSQL in WASM) in memory — tests and the explicit
 *    non-persistent DEMO mode. Never used as a persistent production store.
 */
export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite-memory";
};

export type StorageMode = { kind: Db["kind"]; persistent: boolean; reason: string };

async function openPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  await pg.waitReady;
  type Q = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; exec(sql: string): Promise<unknown> };
  const wrap = (q: Q, nested: boolean): Db => ({
    kind: "pglite-memory",
    async query<T>(sql: string, params: unknown[] = []) {
      return (await q.query<T>(sql, params)).rows;
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (nested) return fn(wrap(q, true));
      return pg.transaction(async (tx) => fn(wrap(tx as unknown as Q, true)));
    },
    async close() {
      await pg.close();
    },
  });
  return wrap(pg as unknown as Q, false);
}

async function openPostgres(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    ssl: url.includes("sslmode=disable") ? false : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
  });
  type C = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> };
  const wrap = (c: C, inTx: boolean): Db => ({
    kind: "postgres",
    async query<T>(sql: string, params: unknown[] = []) {
      return (await c.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await c.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (inTx) return fn(wrap(c, true));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client, true));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  });
  return wrap(pool, false);
}

export function storageMode(): StorageMode {
  if (process.env.DATABASE_URL) return { kind: "postgres", persistent: true, reason: "Managed PostgreSQL (DATABASE_URL)" };
  return {
    kind: "pglite-memory",
    persistent: false,
    reason: "DATABASE_URL 미설정 — 인메모리 DEMO 데이터베이스(서버 재시작 시 초기화)",
  };
}

export async function openDb(opts: { url?: string | null; migrate?: boolean } = {}): Promise<Db> {
  const url = opts.url === undefined ? process.env.DATABASE_URL : opts.url;
  const db = url ? await openPostgres(url) : await openPglite();
  if (opts.migrate !== false) await applyMigrations(db);
  return db;
}

const g = globalThis as unknown as { __ngMuniDb?: Promise<Db> };

/**
 * Process-wide connection. Without DATABASE_URL the app refuses to start in
 * production unless DEMO_MODE=true, and then seeds synthetic data only.
 */
export function getDb(): Promise<Db> {
  if (!g.__ngMuniDb) {
    g.__ngMuniDb = (async () => {
      const mode = storageMode();
      if (!mode.persistent && process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") {
        throw new Error("DATABASE_URL is required in production unless DEMO_MODE=true (non-persistent demo).");
      }
      const db = await openDb();
      if (!mode.persistent || process.env.DEMO_SEED === "true") {
        const { seedIfEmpty } = await import("./seed");
        await seedIfEmpty(db);
      }
      return db;
    })().catch((err) => {
      g.__ngMuniDb = undefined;
      throw err;
    });
  }
  return g.__ngMuniDb;
}

export function setDbForTesting(db: Db | undefined) {
  g.__ngMuniDb = db ? Promise.resolve(db) : undefined;
}

/**
 * Runs `fn` inside a transaction with RLS active for `tenantId`.
 * All request-scoped data access must go through this.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await tx.query(`SET LOCAL ROLE neulgyeot_app`);
    return fn(tx);
  });
}
