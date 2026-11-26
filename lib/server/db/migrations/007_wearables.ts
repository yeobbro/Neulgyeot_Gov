/**
 * Wearable (smart ring / smart watch) integration — Phase 0. See docs/WEARABLE_INTEGRATION.md.
 *
 *  wearable_consents        per-case, per-metric separate consent (민감정보) + legal basis + retention
 *  wearable_devices         a gateway-issued device reference paired with a case under one consent
 *  wearable_daily_summaries one row per device per day (upsert; no raw streams, no location)
 *  wearable_signals         explainable "확인 필요" signals with their basis and staff review
 *
 * All four tables are tenant-isolated by RLS (fail closed). The app role may not DELETE them (retention purge is
 * an owner-run batch). action_tasks gains the 'wearable_check' task type.
 */
import { SIGNAL_STATUSES, DEVICE_KINDS } from "../../../domain/wearable";
import { TASK_TYPES, list } from "../../../domain/enums";

export const version = "007_wearables";

/** Frozen: the consent categories as of 007. Later categories (e.g. temperature in 008) are added by their own migration. */
export const METRICS_007 = ["wear", "activity", "sleep", "heart_rate", "spo2", "fall", "sos"] as const;
/** Frozen: the signal types as of 007 (later types are added by their own migration). */
export const SIGNAL_TYPES_007 = ["fall_reported", "sos_reported", "spo2_low_reported", "no_data", "low_wear", "activity_drop", "sleep_change", "resting_hr_change"] as const;

const TABLES = ["wearable_consents", "wearable_devices", "wearable_daily_summaries", "wearable_signals"];
const rls = (t: string) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON ${t} TO neulgyeot_app;`;

export const up = `
CREATE TABLE wearable_consents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  metrics text[] NOT NULL CHECK (metrics <@ ARRAY[${list(METRICS_007)}]::text[] AND 'wear' = ANY(metrics)),
  legal_basis text NOT NULL CHECK (char_length(legal_basis) BETWEEN 2 AND 200),
  consent_recorded_at timestamptz NOT NULL,
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 1095),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL)
);
CREATE INDEX wearable_consents_case_idx ON wearable_consents (tenant_id, case_id);

CREATE TABLE wearable_devices (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  consent_id text NOT NULL,
  client_id text NOT NULL REFERENCES integration_clients(id),
  device_ref text NOT NULL CHECK (device_ref ~ '^[A-Za-z0-9._:-]{4,64}$'),
  device_kind text NOT NULL CHECK (device_kind IN (${list(DEVICE_KINDS)})),
  model_label text NOT NULL DEFAULT '' CHECK (char_length(model_label) <= 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  paired_at timestamptz NOT NULL DEFAULT now(),
  last_received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (client_id, device_ref),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, consent_id) REFERENCES wearable_consents(tenant_id, id)
);
CREATE INDEX wearable_devices_case_idx ON wearable_devices (tenant_id, case_id);

CREATE TABLE wearable_daily_summaries (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  device_id text NOT NULL,
  case_id text NOT NULL,
  summary_date date NOT NULL,
  wear_minutes integer NOT NULL CHECK (wear_minutes BETWEEN 0 AND 1440),
  steps integer CHECK (steps BETWEEN 0 AND 200000),
  active_minutes integer CHECK (active_minutes BETWEEN 0 AND 1440),
  sleep_minutes integer CHECK (sleep_minutes BETWEEN 0 AND 1440),
  resting_heart_rate integer CHECK (resting_heart_rate BETWEEN 20 AND 250),
  heart_rate_min integer CHECK (heart_rate_min BETWEEN 20 AND 250),
  heart_rate_max integer CHECK (heart_rate_max BETWEEN 20 AND 250),
  spo2_min integer CHECK (spo2_min BETWEEN 50 AND 100),
  fall_events integer CHECK (fall_events BETWEEN 0 AND 100),
  sos_events integer CHECK (sos_events BETWEEN 0 AND 100),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_id, summary_date),
  FOREIGN KEY (tenant_id, device_id) REFERENCES wearable_devices(tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id)
);
CREATE INDEX wearable_summaries_case_idx ON wearable_daily_summaries (tenant_id, case_id, summary_date DESC);

CREATE TABLE wearable_signals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  device_id text NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN (${list(SIGNAL_TYPES_007)})),
  signal_date date NOT NULL,
  message text NOT NULL CHECK (char_length(message) <= 300),
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN (${list(SIGNAL_STATUSES)})),
  task_id text,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text NOT NULL DEFAULT '' CHECK (char_length(review_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_id, signal_type, signal_date),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES wearable_devices(tenant_id, id),
  CHECK (status = 'open' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX wearable_signals_open_idx ON wearable_signals (tenant_id, case_id, status);

${TABLES.map(rls).join("\n")}

ALTER TABLE action_tasks DROP CONSTRAINT IF EXISTS action_tasks_task_type_check;
ALTER TABLE action_tasks ADD CONSTRAINT action_tasks_task_type_check CHECK (task_type IN (${list(TASK_TYPES)}));
`;

// Down keeps existing wearable_check tasks as 'contact_needed' (same meaning, old CHECK accepts it) — nothing is deleted from action_tasks.
export const down = `
UPDATE action_tasks SET task_type = 'contact_needed' WHERE task_type = 'wearable_check';
ALTER TABLE action_tasks DROP CONSTRAINT IF EXISTS action_tasks_task_type_check;
ALTER TABLE action_tasks ADD CONSTRAINT action_tasks_task_type_check CHECK (task_type IN (${list(TASK_TYPES.filter((t) => t !== "wearable_check"))}));
DROP TABLE IF EXISTS wearable_signals;
DROP TABLE IF EXISTS wearable_daily_summaries;
DROP TABLE IF EXISTS wearable_devices;
DROP TABLE IF EXISTS wearable_consents;
`;
