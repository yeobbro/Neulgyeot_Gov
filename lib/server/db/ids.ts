import { randomBytes } from "node:crypto";
import type { Db } from "./client";

/** Opaque, non-sequential primary keys. */
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

/** Readable per-tenant document numbers (e.g. 접수번호 REF-2026-0007). Atomic upsert. */
export async function nextNo(db: Db, tenantId: string, prefix: string, width = 4): Promise<string> {
  const year = new Date().getFullYear();
  const key = `${prefix}-${year}`;
  const [row] = await db.query<{ value: number }>(
    `INSERT INTO id_counters (tenant_id, prefix, value) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, prefix) DO UPDATE SET value = id_counters.value + 1
     RETURNING value`,
    [tenantId, key],
  );
  return `${key}-${String(row.value).padStart(width, "0")}`;
}
