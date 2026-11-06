/**
 * Real PostgreSQL integration tests (opt-in). Set TEST_DATABASE_URL to an ADMIN connection of a throw-away local
 * cluster, e.g. the one from docker-compose.test.yml:
 *   TEST_DATABASE_URL=postgres://gov_test:test-only-local@127.0.0.1:55433/gov_test npm run test:pg
 * Safety: refuses any host other than localhost / 127.0.0.1 / ::1. Every run creates a randomly named database
 * owned by a NON-superuser role with CREATEROLE (like a managed PostgreSQL owner) and drops it afterwards.
 * Synthetic seed data only. Never point this at a shared, staging or production database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDb, type Db } from "../../lib/server/db/client";

export const ADMIN_URL = process.env.TEST_DATABASE_URL;
export const SKIP = ADMIN_URL ? false : "TEST_DATABASE_URL not set — see docs/LOCAL_POSTGRES_TESTING.md";
const OWNER = "neulgyeot_test_owner";
const OWNER_PW = "test-owner-local-only";

function assertLocal(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`TEST_DATABASE_URL must point to a local throw-away cluster (got host ${host})`);
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
  assertLocal(ADMIN_URL!);
  const u = new URL(ADMIN_URL!);
  if (database) u.pathname = `/${database}`;
  const c = new pg.Client({ connectionString: u.toString(), ssl: false });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export type TestDb = { db: Db; url: string; name: string; drop: () => Promise<void> };

/** Fresh database owned by a CREATEROLE (non-superuser) role. `migrate: false` leaves the schema empty. */
export async function createTestDb(o: { migrate?: boolean } = {}): Promise<TestDb> {
  const name = `neulgyeot_test_${randomBytes(4).toString("hex")}`;
  await admin(async (c) => {
    const [r] = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [OWNER])).rows;
    if (!r) await c.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PW}' CREATEROLE NOSUPERUSER NOBYPASSRLS`);
    // the app role is cluster-wide; if an earlier run (or another owner) created it, the owner needs ADMIN on it
    const [app] = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'neulgyeot_app'`)).rows;
    if (app) await c.query(`GRANT neulgyeot_app TO ${OWNER} WITH ADMIN OPTION`);
    await c.query(`CREATE DATABASE ${name} OWNER ${OWNER}`);
  });
  const u = new URL(ADMIN_URL!);
  u.username = OWNER;
  u.password = OWNER_PW;
  u.pathname = `/${name}`;
  u.search = "?sslmode=disable";
  const url = u.toString();
  const db = await openDb({ url, migrate: o.migrate ?? true });
  return {
    db, url, name,
    drop: async () => {
      await db.close().catch(() => undefined);
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** Runs SQL as the cluster admin inside the test database (e.g. to inspect catalogs). */
export const asAdmin = <T>(name: string, fn: (c: pg.Client) => Promise<T>) => admin(fn, name);
