/**
 * Row Level Security: every tenant-scoped table is filtered by
 * current_setting('app.tenant_id'). Request handlers run inside a transaction
 * that sets the tenant and switches to the non-owner role `neulgyeot_app`,
 * so a missing WHERE clause in application code still cannot read or write
 * another tenant's rows. If the setting is absent the policy matches nothing
 * (fail closed).
 *
 * The table-owner connection (migrations, seed, login lookup, integration
 * client authentication) bypasses RLS because the policies are not FORCEd.
 */
export const version = "002_rls";

export const TENANT_TABLES = [
  "tenant_settings", "region_units", "organizations", "service_providers", "users", "user_roles",
  "user_region_scopes", "care_recipients", "recipient_identities", "care_cases", "case_assignments",
  "incoming_referrals", "referral_payload_versions", "referral_events", "consent_evidence",
  "integration_messages", "idempotency_records", "integration_clients", "applications", "case_records",
  "record_revisions", "needs_assessments", "assessment_items", "home_environment_assessments",
  "service_catalog", "provider_service_areas", "provider_capacity_snapshots", "support_plans",
  "support_plan_items", "integrated_support_meetings", "meeting_participants", "meeting_decisions",
  "service_referrals", "service_delivery_events", "monitoring_records", "action_tasks", "notifications",
  "report_snapshots", "ai_drafts", "ai_source_references", "audit_logs", "data_export_logs", "id_counters",
];

/** Append-only history tables: the app role cannot UPDATE or DELETE them. */
export const APPEND_ONLY = ["audit_logs", "referral_events", "service_delivery_events", "record_revisions", "data_export_logs"];

const policy = (t: string) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));`;

export const up = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neulgyeot_app') THEN
    CREATE ROLE neulgyeot_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
GRANT neulgyeot_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO neulgyeot_app;
GRANT SELECT ON tenants TO neulgyeot_app;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON tenants USING (id = current_setting('app.tenant_id', true));
${TENANT_TABLES.filter((t) => !APPEND_ONLY.includes(t)).map((t) => `GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO neulgyeot_app;`).join("\n")}
${APPEND_ONLY.map((t) => `GRANT SELECT, INSERT ON ${t} TO neulgyeot_app;`).join("\n")}
${TENANT_TABLES.map(policy).join("\n")}
`;

export const down = `
${TENANT_TABLES.map((t) => `DROP POLICY IF EXISTS ${t}_tenant_isolation ON ${t}; ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`).join("\n")}
DROP POLICY IF EXISTS tenants_isolation ON tenants;
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM neulgyeot_app;
`;
