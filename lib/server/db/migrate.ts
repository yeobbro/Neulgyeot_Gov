import type { Db } from "./client";
import * as m001 from "./migrations/001_init";
import * as m002 from "./migrations/002_rls";

export const migrations = [m001, m002];

export async function applyMigrations(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ version: string }>(`SELECT version FROM schema_migrations`)).map((r) => r.version));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.up);
      await tx.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [m.version]);
    });
    applied.push(m.version);
  }
  return applied;
}

export async function rollbackAll(db: Db) {
  for (const m of [...migrations].reverse()) {
    await db.exec(m.down);
    await db.query(`DELETE FROM schema_migrations WHERE version = $1`, [m.version]).catch(() => undefined);
  }
}
