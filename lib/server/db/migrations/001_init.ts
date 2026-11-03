import {
  ANSWER_STATUSES,
  ASSESSMENT_DOMAINS,
  ASSESSMENT_KINDS,
  ASSESSMENT_STATUSES,
  CAPACITY_STATUSES,
  CASE_STATUSES,
  INTAKE_ROUTES,
  MONITORING_METHODS,
  PLAN_STATUSES,
  RECORD_TYPES,
  REFERRAL_STATUSES,
  ROLES,
  SERVICE_REFERRAL_STATUSES,
  SERVICE_TYPES,
  TASK_STATUSES,
  TASK_TYPES,
  list,
} from "../../../domain/enums";

export const version = "001_init";

/**
 * Every business table carries tenant_id and a UNIQUE (tenant_id, id) key so
 * child rows reference parents with composite FKs — a row can never point at
 * another tenant's parent. Row Level Security is added in 002_rls.
 */
export const up = `
CREATE TABLE tenants (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  monitoring_interval_days integer NOT NULL DEFAULT 30 CHECK (monitoring_interval_days BETWEEN 7 AND 180),
  plan_approval_roles text[] NOT NULL DEFAULT ARRAY['municipal_admin'],
  intake_allowed_categories text[] NOT NULL,
  ai_enabled boolean NOT NULL DEFAULT false,
  capacity_fresh_days integer NOT NULL DEFAULT 14 CHECK (capacity_fresh_days BETWEEN 1 AND 90),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE region_units (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  parent_id text,
  level text NOT NULL CHECK (level IN ('sigungu', 'eupmyeondong')),
  name text NOT NULL,
  code text NOT NULL,
  map_x double precision,
  map_y double precision,
  is_synthetic boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES region_units(tenant_id, id)
);
CREATE INDEX region_units_parent_idx ON region_units(tenant_id, parent_id);

CREATE TABLE organizations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('municipality', 'eupmyeondong_office', 'provider', 'hospital_partner', 'public_agency')),
  name text NOT NULL,
  region_unit_id text,
  external_code text,
  is_synthetic boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, region_unit_id) REFERENCES region_units(tenant_id, id)
);
CREATE UNIQUE INDEX organizations_external_code_idx ON organizations(tenant_id, external_code) WHERE external_code IS NOT NULL;

CREATE TABLE service_providers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL,
  name text NOT NULL,
  provider_type text NOT NULL,
  address_label text NOT NULL,
  map_x double precision,
  map_y double precision,
  coords_synthetic boolean NOT NULL DEFAULT true,
  contact_label text NOT NULL,
  operating_hours text NOT NULL DEFAULT '',
  visit_days text[] NOT NULL DEFAULT '{}',
  conditions text NOT NULL DEFAULT '',
  data_source text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_synthetic boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organizations(tenant_id, id)
);

CREATE TABLE users (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  is_active boolean NOT NULL DEFAULT true,
  is_demo_account boolean NOT NULL DEFAULT false,
  provider_id text,
  can_confirm_official_determination boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organizations(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES service_providers(tenant_id, id)
);

CREATE TABLE user_roles (
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN (${list(ROLES)})),
  granted_by text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE user_region_scopes (
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id text NOT NULL,
  region_unit_id text NOT NULL,
  PRIMARY KEY (user_id, region_unit_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, region_unit_id) REFERENCES region_units(tenant_id, id)
);

CREATE TABLE care_recipients (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  recipient_code text NOT NULL,
  display_name text NOT NULL,
  age_band text,
  region_unit_id text NOT NULL,
  household_type text,
  is_synthetic boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, recipient_code),
  FOREIGN KEY (tenant_id, region_unit_id) REFERENCES region_units(tenant_id, id)
);

-- Direct identifiers are kept apart from case work data (restricted access).
CREATE TABLE recipient_identities (
  recipient_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  legal_name text NOT NULL,
  birth_date date,
  contact text,
  external_subject_ref text,
  source_basis text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, recipient_id) REFERENCES care_recipients(tenant_id, id)
);

CREATE TABLE care_cases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_code text NOT NULL,
  recipient_id text NOT NULL,
  region_unit_id text NOT NULL,
  status text NOT NULL CHECK (status IN (${list(CASE_STATUSES)})),
  intake_route text NOT NULL CHECK (intake_route IN (${list(INTAKE_ROUTES)})),
  primary_worker_id text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closure_reason text,
  last_contact_at timestamptz,
  next_action_at timestamptz,
  next_action_label text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, case_code),
  FOREIGN KEY (tenant_id, recipient_id) REFERENCES care_recipients(tenant_id, id),
  FOREIGN KEY (tenant_id, region_unit_id) REFERENCES region_units(tenant_id, id),
  FOREIGN KEY (tenant_id, primary_worker_id) REFERENCES users(tenant_id, id),
  CHECK ((status IN ('CLOSED', 'WITHDRAWN')) = (closed_at IS NOT NULL))
);
CREATE INDEX care_cases_status_idx ON care_cases(tenant_id, status);
CREATE INDEX care_cases_region_idx ON care_cases(tenant_id, region_unit_id);

CREATE TABLE case_assignments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  user_id text NOT NULL,
  assignment_role text NOT NULL CHECK (assignment_role IN ('primary', 'secondary')),
  assigned_by text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX case_assignments_active_idx ON case_assignments(case_id, user_id) WHERE ended_at IS NULL;

CREATE TABLE incoming_referrals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  transfer_id text NOT NULL,
  receipt_no text NOT NULL,
  source_org_code text NOT NULL,
  source_org_name text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  discharge_date date,
  subject_ref text NOT NULL,
  subject_display text NOT NULL,
  region_unit_id text,
  requested_services text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN (${list(REFERRAL_STATUSES)})),
  consent_check_status text NOT NULL CHECK (consent_check_status IN ('verified', 'pending_review', 'failed')),
  schema_version text NOT NULL,
  trace_id text NOT NULL,
  validation jsonb NOT NULL DEFAULT '{}',
  missing_items text[] NOT NULL DEFAULT '{}',
  assigned_user_id text,
  case_id text,
  decline_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, transfer_id),
  UNIQUE (tenant_id, receipt_no),
  FOREIGN KEY (tenant_id, region_unit_id) REFERENCES region_units(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  CHECK (status <> 'DECLINED' OR decline_reason IS NOT NULL)
);
CREATE INDEX incoming_referrals_status_idx ON incoming_referrals(tenant_id, status);

CREATE TABLE referral_payload_versions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  referral_id text NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (referral_id, version_no),
  FOREIGN KEY (tenant_id, referral_id) REFERENCES incoming_referrals(tenant_id, id)
);

CREATE TABLE referral_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  referral_id text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_id text,
  actor_label text NOT NULL,
  note text,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, referral_id) REFERENCES incoming_referrals(tenant_id, id)
);
CREATE INDEX referral_events_ref_idx ON referral_events(referral_id, at);

CREATE TABLE consent_evidence (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  referral_id text NOT NULL,
  payload_version_id text NOT NULL,
  category text NOT NULL,
  sensitive boolean NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'pending_review', 'blocked_by_policy')),
  reason text NOT NULL,
  purpose text,
  retention text NOT NULL,
  legal_basis text,
  separate_consent_status text NOT NULL,
  consent_recorded_at timestamptz NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  UNIQUE (payload_version_id, category),
  FOREIGN KEY (tenant_id, referral_id) REFERENCES incoming_referrals(tenant_id, id),
  FOREIGN KEY (tenant_id, payload_version_id) REFERENCES referral_payload_versions(tenant_id, id)
);

-- Metadata only: never message bodies.
CREATE TABLE integration_messages (
  id text PRIMARY KEY,
  tenant_id text REFERENCES tenants(id),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  kind text NOT NULL,
  transfer_id text,
  trace_id text,
  client_id text,
  http_status integer,
  error_code text,
  delivery_status text NOT NULL DEFAULT 'done' CHECK (delivery_status IN ('done', 'queued', 'failed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_messages_transfer_idx ON integration_messages(tenant_id, transfer_id);

CREATE TABLE idempotency_records (
  tenant_id text NOT NULL REFERENCES tenants(id),
  idem_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idem_key)
);

CREATE TABLE integration_clients (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  source_org_code text NOT NULL,
  source_org_name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  application_no text NOT NULL,
  route text NOT NULL CHECK (route IN (${list(INTAKE_ROUTES)})),
  applicant_type text NOT NULL CHECK (applicant_type IN ('self', 'family', 'agency', 'hospital', 'official')),
  incoming_referral_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  summary text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, application_no),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, incoming_referral_id) REFERENCES incoming_referrals(tenant_id, id)
);

CREATE TABLE case_records (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  record_type text NOT NULL CHECK (record_type IN (${list(RECORD_TYPES)})),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  occurred_at timestamptz NOT NULL,
  author_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX case_records_case_idx ON case_records(case_id, occurred_at DESC);

CREATE TABLE record_revisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  record_id text NOT NULL,
  revision integer NOT NULL,
  previous_body text NOT NULL,
  edited_by text NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  UNIQUE (record_id, revision),
  FOREIGN KEY (tenant_id, record_id) REFERENCES case_records(tenant_id, id)
);

CREATE TABLE needs_assessments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (${list(ASSESSMENT_KINDS)})),
  status text NOT NULL CHECK (status IN (${list(ASSESSMENT_STATUSES)})),
  surveyed_at date,
  surveyor_id text NOT NULL,
  confirmed_by text,
  confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, surveyor_id) REFERENCES users(tenant_id, id),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);

CREATE TABLE assessment_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  assessment_id text NOT NULL,
  domain text NOT NULL CHECK (domain IN (${list(ASSESSMENT_DOMAINS)})),
  answer_status text CHECK (answer_status IN (${list(ANSWER_STATUSES)})),
  value text NOT NULL DEFAULT '' CHECK (char_length(value) <= 1000),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  UNIQUE (assessment_id, domain),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES needs_assessments(tenant_id, id)
);

CREATE TABLE home_environment_assessments (
  assessment_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  housing_type text,
  barriers text[] NOT NULL DEFAULT '{}',
  heating_cooling text,
  safety_notes text NOT NULL DEFAULT '',
  modification_needed boolean,
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES needs_assessments(tenant_id, id)
);

CREATE TABLE service_catalog (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  service_type text NOT NULL CHECK (service_type IN (${list(SERVICE_TYPES)})),
  name text NOT NULL,
  department text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, service_type)
);

CREATE TABLE provider_service_areas (
  tenant_id text NOT NULL REFERENCES tenants(id),
  provider_id text NOT NULL,
  region_unit_id text NOT NULL,
  service_type text NOT NULL CHECK (service_type IN (${list(SERVICE_TYPES)})),
  PRIMARY KEY (provider_id, region_unit_id, service_type),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES service_providers(tenant_id, id),
  FOREIGN KEY (tenant_id, region_unit_id) REFERENCES region_units(tenant_id, id)
);

CREATE TABLE provider_capacity_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  provider_id text NOT NULL,
  service_type text NOT NULL CHECK (service_type IN (${list(SERVICE_TYPES)})),
  status text NOT NULL CHECK (status IN (${list(CAPACITY_STATUSES)})),
  waitlist_count integer CHECK (waitlist_count >= 0),
  confirmed_at timestamptz NOT NULL,
  confirmed_by text,
  source text NOT NULL,
  FOREIGN KEY (tenant_id, provider_id) REFERENCES service_providers(tenant_id, id)
);
CREATE INDEX provider_capacity_latest_idx ON provider_capacity_snapshots(provider_id, service_type, confirmed_at DESC);

CREATE TABLE support_plans (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  version_no integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN (${list(PLAN_STATUSES)})),
  goals text NOT NULL DEFAULT '',
  main_needs text NOT NULL DEFAULT '',
  recipient_wishes text NOT NULL DEFAULT '',
  additional_checks text NOT NULL DEFAULT '',
  start_date date,
  review_date date,
  owner_id text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  approval_basis text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (case_id, version_no),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id),
  CHECK (status NOT IN ('APPROVED', 'REFERRING', 'IN_PROGRESS') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE support_plan_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  plan_id text NOT NULL,
  service_type text NOT NULL CHECK (service_type IN (${list(SERVICE_TYPES)})),
  department text NOT NULL,
  provider_id text,
  frequency text NOT NULL,
  start_date date,
  end_date date,
  method text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES support_plans(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES service_providers(tenant_id, id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE integrated_support_meetings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  plan_id text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled', 'held', 'canceled')),
  agenda text NOT NULL,
  confirmed_facts text NOT NULL DEFAULT '',
  open_questions text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT '',
  recorded_by text,
  recorded_at timestamptz,
  created_by text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES support_plans(tenant_id, id),
  CHECK (status <> 'held' OR (recorded_by IS NOT NULL AND recorded_at IS NOT NULL))
);

CREATE TABLE meeting_participants (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  meeting_id text NOT NULL,
  organization_name text NOT NULL,
  participant_role text NOT NULL,
  attended boolean,
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES integrated_support_meetings(tenant_id, id)
);

CREATE TABLE meeting_decisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  meeting_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve_plan', 'revise_plan', 'defer')),
  content text NOT NULL CHECK (char_length(content) >= 5),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES integrated_support_meetings(tenant_id, id)
);

CREATE TABLE service_referrals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  referral_no text NOT NULL,
  case_id text NOT NULL,
  plan_item_id text NOT NULL,
  provider_id text NOT NULL,
  service_type text NOT NULL CHECK (service_type IN (${list(SERVICE_TYPES)})),
  status text NOT NULL CHECK (status IN (${list(SERVICE_REFERRAL_STATUSES)})),
  request_note text NOT NULL DEFAULT '',
  provider_note text,
  unavailable_reason text,
  scheduled_start date,
  completed_at timestamptz,
  requested_by text NOT NULL,
  requested_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, referral_no),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, plan_item_id) REFERENCES support_plan_items(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES service_providers(tenant_id, id),
  CHECK (status <> 'UNAVAILABLE' OR unavailable_reason IS NOT NULL),
  CHECK (status NOT IN ('SCHEDULED', 'STARTED', 'COMPLETED') OR scheduled_start IS NOT NULL)
);
CREATE INDEX service_referrals_provider_idx ON service_referrals(tenant_id, provider_id, status);
CREATE INDEX service_referrals_case_idx ON service_referrals(case_id);

CREATE TABLE service_delivery_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  service_referral_id text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text,
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('staff', 'provider')),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, service_referral_id) REFERENCES service_referrals(tenant_id, id)
);

CREATE TABLE monitoring_records (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text NOT NULL,
  checked_at timestamptz NOT NULL,
  method text NOT NULL CHECK (method IN (${list(MONITORING_METHODS)})),
  service_used text NOT NULL CHECK (service_used IN ('yes', 'partial', 'no', 'unknown')),
  satisfaction text CHECK (satisfaction IN ('satisfied', 'neutral', 'dissatisfied', 'no_response')),
  status_change text NOT NULL DEFAULT '',
  non_delivery_reason text,
  additional_needs text NOT NULL DEFAULT '',
  plan_change_needed boolean NOT NULL,
  next_due_at date,
  opinion text NOT NULL DEFAULT '',
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  CHECK (service_used NOT IN ('no', 'partial') OR non_delivery_reason IS NOT NULL)
);
CREATE INDEX monitoring_case_idx ON monitoring_records(case_id, checked_at DESC);

CREATE TABLE action_tasks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text,
  referral_id text,
  task_type text NOT NULL CHECK (task_type IN (${list(TASK_TYPES)})),
  title text NOT NULL,
  due_at date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN (${list(TASK_STATUSES)})),
  assignee_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, referral_id) REFERENCES incoming_referrals(tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX action_tasks_open_idx ON action_tasks(tenant_id, status, due_at);

CREATE TABLE notifications (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE report_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  report_type text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  definition jsonb NOT NULL,
  data jsonb NOT NULL,
  generated_by text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);

CREATE TABLE ai_drafts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  case_id text,
  referral_id text,
  kind text NOT NULL CHECK (kind IN ('referral_summary', 'social_opinion', 'meeting_brief')),
  engine text NOT NULL CHECK (engine IN ('rules', 'llm')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'discarded')),
  content jsonb NOT NULL,
  edited_text text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES care_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, referral_id) REFERENCES incoming_referrals(tenant_id, id),
  CHECK (status = 'draft' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE ai_source_references (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  draft_id text NOT NULL,
  sentence_index integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  field text,
  FOREIGN KEY (tenant_id, draft_id) REFERENCES ai_drafts(tenant_id, id)
);

-- Audit metadata only. No personal or health text is stored here.
CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  tenant_id text REFERENCES tenants(id),
  actor_id text,
  actor_role text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  meta jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_at_idx ON audit_logs(tenant_id, at DESC);

CREATE TABLE data_export_logs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  actor_id text NOT NULL,
  export_type text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'print')),
  filters jsonb NOT NULL DEFAULT '{}',
  row_count integer NOT NULL,
  contains_personal_data boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE id_counters (
  tenant_id text NOT NULL,
  prefix text NOT NULL,
  value integer NOT NULL,
  PRIMARY KEY (tenant_id, prefix)
)
`;

export const down = `
DROP TABLE IF EXISTS id_counters, data_export_logs, audit_logs, ai_source_references, ai_drafts, report_snapshots,
  notifications, action_tasks, monitoring_records, service_delivery_events, service_referrals, meeting_decisions,
  meeting_participants, integrated_support_meetings, support_plan_items, support_plans, provider_capacity_snapshots,
  provider_service_areas, service_catalog, home_environment_assessments, assessment_items, needs_assessments,
  record_revisions, case_records, applications, integration_clients, idempotency_records, integration_messages,
  consent_evidence, referral_events, referral_payload_versions, incoming_referrals, case_assignments, care_cases,
  recipient_identities, care_recipients, user_region_scopes, user_roles, users, service_providers, organizations,
  region_units, tenant_settings, tenants CASCADE
`;
