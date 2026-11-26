/**
 * 통합 관제 (integrated control view). See docs/CONTROL_DASHBOARD.md.
 *
 *  care_locations     designated location per case (거주지 등) — approximate, entered by staff
 *  location_consents  separate consent for collecting the CURRENT location (위치정보법·개인정보 보호법) — short retention
 *  location_fixes     recent position fixes from a registered device (only accepted with an active location consent)
 *  wearable_readings  near-real-time vital snapshots (heart rate, temperature, SpO2, fall/SOS events) — short retention
 *  control_alerts     "즉시 확인" items raised from readings; one open alert per (case, kind)
 *  field_dispatches   현장 출동요청 to a staff member, with its own status flow
 *  service_visits     scheduled / in-progress / completed field visits of service providers
 *
 * All tables are tenant-isolated by RLS (fail closed). The app role never DELETEs; retention purge is an owner batch.
 * wearable_consents gains the `temperature` category.
 */
import { ALERT_KINDS, ALERT_STATUSES, DISPATCH_STATUSES, READING_EVENTS, VISIT_STATUSES } from "../../../domain/control";
import { SERVICE_TYPES, list } from "../../../domain/enums";
import { METRICS_007 } from "./007_wearables";

export const version = "008_control";

/** Frozen: consent categories as of 008 (007 + temperature). */
export const METRICS_008 = [...METRICS_007, "temperature"] as const;

const rls = (t: string, grants = "SELECT, INSERT, UPDATE") => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT ${grants} ON ${t} TO neulgyeot_app;`;

const lat = (c: string) => `${c} double precision NOT NULL CHECK (${c} BETWEEN -90 AND 90)`;
const lng = (c: string) => `${c} double precision NOT NULL CHECK (${c} BETWEEN -180 AND 180)`;

export const up = `
ALTER TABLE wearable_consents DROP CONSTRAINT IF EXISTS wearable_consents_metrics_check;
ALTER TABLE wearable_consents ADD CONSTRAINT wearable_consents_metrics_check CHECK (metrics <@ ARRAY[${list(METRICS_008)}]::text[] AND 'wear' = ANY(metrics));

CREATE TABLE care_locations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 120),
  ${lat("latitude")},
  ${lng("longitude")},
  precision text NOT NULL DEFAULT 'approximate' CHECK (precision IN ('approximate', 'exact')),
  recorded_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id)
);

CREATE TABLE location_consents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  legal_basis text NOT NULL CHECK (char_length(legal_basis) BETWEEN 2 AND 200),
  consent_recorded_at timestamptz NOT NULL,
  retention_hours integer NOT NULL CHECK (retention_hours BETWEEN 1 AND 720),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL)
);
CREATE UNIQUE INDEX location_consents_active_idx ON location_consents (tenant_id, case_id) WHERE status = 'active';

CREATE TABLE location_fixes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  device_id text NOT NULL,
  ${lat("latitude")},
  ${lng("longitude")},
  accuracy_m integer CHECK (accuracy_m BETWEEN 0 AND 10000),
  measured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_id, measured_at),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES wearable_devices(tenant_id, id)
);
CREATE INDEX location_fixes_case_idx ON location_fixes (tenant_id, case_id, measured_at DESC);

CREATE TABLE wearable_readings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  device_id text NOT NULL,
  measured_at timestamptz NOT NULL,
  heart_rate integer CHECK (heart_rate BETWEEN 20 AND 250),
  body_temp_c double precision CHECK (body_temp_c BETWEEN 30 AND 45),
  spo2 integer CHECK (spo2 BETWEEN 50 AND 100),
  event text CHECK (event IN (${list(READING_EVENTS)})),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_id, measured_at),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES wearable_devices(tenant_id, id)
);
CREATE INDEX wearable_readings_case_idx ON wearable_readings (tenant_id, case_id, measured_at DESC);

CREATE TABLE control_alerts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  device_id text,
  kind text NOT NULL CHECK (kind IN (${list(ALERT_KINDS)})),
  severity text NOT NULL CHECK (severity IN ('urgent', 'caution')),
  message text NOT NULL CHECK (char_length(message) <= 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN (${list(ALERT_STATUSES)})),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  handled_by text,
  handled_at timestamptz,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  CHECK (status = 'open' OR (handled_by IS NOT NULL AND handled_at IS NOT NULL))
);
CREATE UNIQUE INDEX control_alerts_one_open_idx ON control_alerts (tenant_id, case_id, kind) WHERE status <> 'resolved';

CREATE TABLE field_dispatches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  alert_id text,
  requested_by text NOT NULL,
  assignee_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 300),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (${list(DISPATCH_STATUSES)})),
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  arrived_at timestamptz,
  closed_at timestamptz,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, alert_id) REFERENCES control_alerts(tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX field_dispatches_one_active_idx ON field_dispatches (tenant_id, case_id) WHERE status IN ('requested', 'accepted', 'on_site');

CREATE TABLE service_visits (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  service_referral_id text,
  provider_id text NOT NULL,
  service_type text NOT NULL CHECK (service_type IN (${list(SERVICE_TYPES)})),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN (${list(VISIT_STATUSES)})),
  started_at timestamptz,
  completed_at timestamptz,
  staff_label text NOT NULL DEFAULT '' CHECK (char_length(staff_label) <= 60),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, service_referral_id) REFERENCES service_referrals(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES service_providers(tenant_id, id)
);
CREATE INDEX service_visits_day_idx ON service_visits (tenant_id, scheduled_at);

${rls("care_locations")}
${rls("location_consents")}
${rls("location_fixes", "SELECT, INSERT")}
${rls("wearable_readings", "SELECT, INSERT")}
${rls("control_alerts")}
${rls("field_dispatches")}
${rls("service_visits")}
`;

// Down drops 008 data; consents that used `temperature` lose that category (it did not exist before 008).
export const down = `
DROP TABLE IF EXISTS service_visits;
DROP TABLE IF EXISTS field_dispatches;
DROP TABLE IF EXISTS control_alerts;
DROP TABLE IF EXISTS wearable_readings;
DROP TABLE IF EXISTS location_fixes;
DROP TABLE IF EXISTS location_consents;
DROP TABLE IF EXISTS care_locations;
UPDATE wearable_consents SET metrics = array_remove(metrics, 'temperature') WHERE 'temperature' = ANY(metrics);
ALTER TABLE wearable_consents DROP CONSTRAINT IF EXISTS wearable_consents_metrics_check;
ALTER TABLE wearable_consents ADD CONSTRAINT wearable_consents_metrics_check CHECK (metrics <@ ARRAY[${list(METRICS_007)}]::text[] AND 'wear' = ANY(metrics));
`;
