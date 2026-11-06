/**
 * Asynchronous AI jobs. A job asks the AI provider to propose an alternative to an existing RULE draft.
 * The AI call itself runs outside any DB transaction (see lib/server/ai/jobs.ts); this table only tracks state.
 *
 * Privacy: no FactBook text, prompts, model output or tokens are stored here — only ids, codes, counts,
 * timestamps and a fixed, pre-written safe message per error code.
 * Tenant isolation: RLS like every other tenant table (fail closed); app role may not DELETE.
 * ai_drafts gains the provider engines ('ai-intelligence', 'hybrid') and a link to the job that produced it.
 */
export const version = "005_ai_jobs";

export const up = `
CREATE TABLE ai_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  draft_id text NOT NULL,
  job_type text NOT NULL CHECK (job_type IN ('draft_compose')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  requested_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,80}$'),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,40}$'),
  error_message_safe text CHECK (error_message_safe IS NULL OR char_length(error_message_safe) <= 200),
  engine text CHECK (engine IS NULL OR engine IN ('rules', 'ai-intelligence', 'hybrid')),
  model_version text CHECK (model_version IS NULL OR char_length(model_version) <= 160),
  prompt_version text CHECK (prompt_version IS NULL OR char_length(prompt_version) <= 80),
  ai_request_id text CHECK (ai_request_id IS NULL OR ai_request_id ~ '^req_[0-9a-f]{20}$'),
  result_draft_id text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES ai_drafts(tenant_id, id),
  FOREIGN KEY (tenant_id, result_draft_id) REFERENCES ai_drafts(tenant_id, id),
  CHECK (attempt_count <= max_attempts),
  CHECK (status <> 'processing' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL)),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND result_draft_id IS NOT NULL)),
  CHECK (status <> 'failed' OR (failed_at IS NOT NULL AND error_code IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
-- at most one active job per draft and type (duplicate requests attach to it)
CREATE UNIQUE INDEX ai_jobs_one_active_per_draft ON ai_jobs (tenant_id, draft_id, job_type) WHERE status IN ('pending', 'processing');
CREATE INDEX ai_jobs_claim_idx ON ai_jobs (tenant_id, status, next_attempt_at);
CREATE INDEX ai_jobs_draft_idx ON ai_jobs (tenant_id, draft_id);

ALTER TABLE ai_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_jobs_tenant_isolation ON ai_jobs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON ai_jobs TO neulgyeot_app;

ALTER TABLE ai_drafts DROP CONSTRAINT ai_drafts_engine_check;
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_engine_check CHECK (engine IN ('rules', 'llm', 'ai-intelligence', 'hybrid'));
ALTER TABLE ai_drafts ADD COLUMN source_job_id text;
`;

// Down refuses to run while provider-engine drafts exist (the old CHECK would reject them); delete or
// archive those drafts deliberately first — data is never dropped implicitly.
export const down = `
DROP TABLE IF EXISTS ai_jobs;
ALTER TABLE ai_drafts DROP COLUMN IF EXISTS source_job_id;
ALTER TABLE ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_engine_check;
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_engine_check CHECK (engine IN ('rules', 'llm'));
`;
