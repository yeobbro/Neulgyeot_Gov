/** Migrations 001–006 on real PostgreSQL: apply, re-apply, full rollback, legacy backfill, one-target validation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMigrations, migrations, rollbackAll } from "../../lib/server/db/migrate";
import { TENANT_TABLES } from "../../lib/server/db/migrations/002_rls";
import * as m005 from "../../lib/server/db/migrations/005_ai_jobs";
import * as m006 from "../../lib/server/db/migrations/006_ai_draft_review";
import { seed } from "../../lib/server/db/seed";
import { asAdmin, createTestDb, SKIP } from "./pg-helpers";

const versions = migrations.map((m) => m.version);

test("001–006 apply on an empty database as a non-superuser owner; re-running is a no-op", { skip: SKIP }, async () => {
  const t = await createTestDb();
  try {
    const applied = (await t.db.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`)).map((r) => r.version);
    assert.deepEqual(applied, versions);
    assert.deepEqual(await applyMigrations(t.db), [], "second run applies nothing");
    const [me] = await t.db.query<{ rolsuper: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    assert.deepEqual(me, { rolsuper: false, rolcreaterole: true, rolbypassrls: false }, "migrations ran as a managed-PG style owner");
    const [app] = await t.db.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'neulgyeot_app'`);
    assert.deepEqual(app, { rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    await t.db.transaction((tx) => seed(tx));
  } finally {
    await t.drop();
  }
});

test("RLS is enabled with a tenant policy on every tenant table incl. ai_jobs; app role has no DELETE on ai_jobs", { skip: SKIP }, async () => {
  const t = await createTestDb();
  try {
    for (const table of [...TENANT_TABLES, "ai_jobs"]) {
      const [r] = await t.db.query<{ rls: boolean; policies: number }>(
        `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies FROM pg_class c WHERE c.relname = $1 AND c.relkind = 'r'`, [table]);
      assert.ok(r, `${table} exists`);
      assert.equal(r.rls, true, `${table} RLS`);
      assert.ok(r.policies >= 1, `${table} policy`);
    }
    const priv = async (table: string, p: string) =>
      (await t.db.query<{ ok: boolean }>(`SELECT has_table_privilege('neulgyeot_app', $1, $2) AS ok`, [table, p]))[0].ok;
    assert.equal(await priv("ai_jobs", "SELECT"), true);
    assert.equal(await priv("ai_jobs", "UPDATE"), true);
    assert.equal(await priv("ai_jobs", "DELETE"), false);
    assert.equal(await priv("audit_logs", "UPDATE"), false, "append-only");
    assert.equal(await priv("audit_logs", "DELETE"), false);
  } finally {
    await t.drop();
  }
});

test("full rollback (006 → 001) and re-apply on a seeded database", { skip: SKIP }, async () => {
  const t = await createTestDb();
  try {
    await t.db.transaction((tx) => seed(tx));
    await rollbackAll(t.db);
    const left = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
    assert.equal(left[0].n, 0, "every table dropped");
    assert.deepEqual(await applyMigrations(t.db), versions, "all six re-applied");
    await t.db.transaction((tx) => seed(tx));
  } finally {
    await t.drop();
  }
});

test("006 on legacy data: backfill, split double approvals, NOT VALID one-target, VALIDATE after cleanup", { skip: SKIP }, async () => {
  const t = await createTestDb({ migrate: false });
  try {
    // the database as it would look with 001–005 applied and the pre-review-workflow code running
    await t.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const m of migrations.slice(0, 5)) {
      await t.db.transaction(async (tx) => {
        await tx.exec(m.up);
        await tx.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [m.version]);
      });
    }
    await t.db.transaction((tx) => seed(tx));
    const ins = (id: string, o: { status: string; engine?: string; source?: string; caseId?: string | null; referralId?: string | null; kind?: string; at?: string }) =>
      t.db.query(
        `INSERT INTO ai_drafts (id, tenant_id, case_id, referral_id, kind, engine, status, content, created_by, reviewed_by, reviewed_at)
         VALUES ($1,'tn_gaon',$2,$3,$4,$5,$6,$7,'usr_gaon_cm1',$8,$9)`,
        [id, o.caseId ?? null, o.referralId === undefined ? "ir_2" : o.referralId, o.kind ?? "referral_summary", o.engine ?? "rules", o.status,
          JSON.stringify({ sections: [], facts: [], text: "합성", ...(o.source ? { ai: { sourceDraftId: o.source } } : {}) }),
          o.status === "draft" ? null : "usr_gaon_cm1", o.status === "draft" ? null : o.at ?? "2026-01-01"]);
    await ins("aid_lg_root", { status: "approved", at: "2026-01-02" });
    await ins("aid_lg_ai_ok", { status: "approved", engine: "hybrid", source: "aid_lg_root", at: "2026-01-01" });
    await ins("aid_lg_ai_dis", { status: "discarded", engine: "hybrid", source: "aid_lg_root" });
    await ins("aid_lg_open", { status: "draft" });
    await ins("aid_lg_dual", { status: "draft", kind: "social_opinion", caseId: "case_3", referralId: "ir_2" }); // legacy: both targets

    assert.deepEqual(await applyMigrations(t.db), ["006_ai_draft_review"]);
    const rows = Object.fromEntries((await t.db.query<{ id: string; draft_group_id: string; status: string; selection_status: string }>(
      `SELECT id, draft_group_id, status, selection_status FROM ai_drafts WHERE id LIKE 'aid_lg_%'`)).map((r) => [r.id, r]));
    assert.equal(rows.aid_lg_root.draft_group_id, "aid_lg_root");
    assert.equal(rows.aid_lg_ai_ok.draft_group_id, "aid_lg_ai_ok", "second approval split into its own group");
    assert.equal(rows.aid_lg_ai_dis.draft_group_id, "aid_lg_root");
    assert.deepEqual([rows.aid_lg_root.selection_status, rows.aid_lg_ai_ok.selection_status], ["selected", "selected"]);
    assert.equal(rows.aid_lg_ai_dis.selection_status, "set_aside");
    assert.equal(rows.aid_lg_open.selection_status, "candidate");
    assert.equal(rows.aid_lg_dual.draft_group_id, "aid_lg_dual");

    const [c] = await t.db.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint WHERE conname = 'ai_drafts_one_target'`);
    assert.equal(c.convalidated, false, "added NOT VALID so the legacy row does not block the migration");
    await assert.rejects(t.db.exec(`ALTER TABLE ai_drafts VALIDATE CONSTRAINT ai_drafts_one_target`), /ai_drafts_one_target/, "validation finds the legacy row");
    await assert.rejects(t.db.query(`INSERT INTO ai_drafts (id, tenant_id, case_id, referral_id, kind, engine, status, content, created_by, draft_group_id)
      VALUES ('aid_lg_new','tn_gaon','case_3','ir_2','social_opinion','rules','draft','{}','usr_gaon_cm1','aid_lg_new')`), /ai_drafts_one_target/, "new dual-target rows are refused");
    // operator cleanup of the legacy row, then validation succeeds
    await t.db.query(`UPDATE ai_drafts SET referral_id = NULL WHERE id = 'aid_lg_dual'`);
    await t.db.exec(`ALTER TABLE ai_drafts VALIDATE CONSTRAINT ai_drafts_one_target`);
    const [c2] = await t.db.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint WHERE conname = 'ai_drafts_one_target'`);
    assert.equal(c2.convalidated, true);

    // 006 down/up with this data; 005 down refuses while provider-engine drafts exist (no implicit data loss)
    await t.db.exec(m006.down);
    await t.db.exec(m006.up);
    await t.db.exec(m006.down);
    await assert.rejects(t.db.exec(m005.down), /ai_drafts_engine_check|violated|check constraint/i);
    const [still] = await t.db.query<{ r: string | null }>(`SELECT to_regclass('public.ai_jobs')::text AS r`);
    assert.equal(still.r, "ai_jobs", "the failed down was atomic");
    await t.db.exec(m006.up);
    await asAdmin(t.name, async (a) => assert.equal((await a.query(`SELECT count(*)::int AS n FROM ai_drafts WHERE id LIKE 'aid_lg_%'`)).rows[0].n, 5, "no row lost"));
  } finally {
    await t.drop();
  }
});
