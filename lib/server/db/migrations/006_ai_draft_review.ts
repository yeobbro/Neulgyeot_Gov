/**
 * Draft review workflow: a rule draft and the AI proposals made from it form one GROUP. A reviewer compares them,
 * SELECTS one (selection is not approval), and only the selected draft can be approved through the existing
 * approve/discard flow. Reuses existing columns instead of duplicating them:
 *   source type        → ai_drafts.engine ('rules' vs 'ai-intelligence' | 'hybrid')
 *   discarded_at / by  → ai_drafts.status = 'discarded' + reviewed_at / reviewed_by
 * New: draft_group_id, selection_status, selected_by, selected_at (+ integrity constraints).
 *
 * Not applied to any production database by this change. Backfill is deterministic: every existing draft becomes
 * the root of its own group; existing approved drafts become the selected draft of their group.
 */
export const version = "006_ai_draft_review";

export const up = `
ALTER TABLE ai_drafts ADD COLUMN draft_group_id text;
UPDATE ai_drafts SET draft_group_id = COALESCE(content #>> '{ai,sourceDraftId}', id);
-- legacy safety: before this workflow a rule draft and an AI proposal made from it could BOTH be approved. Keep the
-- group's approval (the root's if approved, otherwise the earliest); any other approved draft becomes the root of
-- its own group, so the one-approved/one-selected indexes below can be built. Nothing is deleted or un-approved.
UPDATE ai_drafts d SET draft_group_id = d.id
 WHERE d.id <> d.draft_group_id AND d.status = 'approved'
   AND EXISTS (SELECT 1 FROM ai_drafts o
                WHERE o.tenant_id = d.tenant_id AND o.draft_group_id = d.draft_group_id AND o.id <> d.id AND o.status = 'approved'
                  AND (o.id = o.draft_group_id OR (o.reviewed_at, o.id) < (d.reviewed_at, d.id)));
ALTER TABLE ai_drafts ALTER COLUMN draft_group_id SET NOT NULL;
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_group_fk FOREIGN KEY (tenant_id, draft_group_id) REFERENCES ai_drafts(tenant_id, id);

ALTER TABLE ai_drafts ADD COLUMN selection_status text NOT NULL DEFAULT 'candidate'
  CHECK (selection_status IN ('candidate', 'selected', 'set_aside'));
ALTER TABLE ai_drafts ADD COLUMN selected_by text;
ALTER TABLE ai_drafts ADD COLUMN selected_at timestamptz;
UPDATE ai_drafts SET selection_status = 'selected', selected_by = reviewed_by, selected_at = reviewed_at WHERE status = 'approved';
UPDATE ai_drafts SET selection_status = 'set_aside' WHERE status = 'discarded';

ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_selected_meta CHECK (selection_status <> 'selected' OR (selected_by IS NOT NULL AND selected_at IS NOT NULL));
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_discarded_not_selected CHECK (status <> 'discarded' OR selection_status <> 'selected');
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_approved_is_selected CHECK (status <> 'approved' OR selection_status = 'selected');
-- one target per draft. NOT VALID: enforced for new/updated rows without failing on any legacy row; run
-- "ALTER TABLE ai_drafts VALIDATE CONSTRAINT ai_drafts_one_target" after checking existing data.
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_one_target CHECK (num_nonnulls(case_id, referral_id) = 1) NOT VALID;

-- at most one selected and at most one approved draft per group (concurrent requests resolve in the database)
CREATE UNIQUE INDEX ai_drafts_one_selected_per_group ON ai_drafts (tenant_id, draft_group_id) WHERE selection_status = 'selected';
CREATE UNIQUE INDEX ai_drafts_one_approved_per_group ON ai_drafts (tenant_id, draft_group_id) WHERE status = 'approved';
CREATE INDEX ai_drafts_group_idx ON ai_drafts (tenant_id, draft_group_id);

-- the AI draft's producing job must exist in the same tenant (review finding: dangling source_job_id)
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_source_job_fk FOREIGN KEY (tenant_id, source_job_id) REFERENCES ai_jobs(tenant_id, id);
CREATE INDEX ai_drafts_source_job_idx ON ai_drafts (tenant_id, source_job_id) WHERE source_job_id IS NOT NULL;
`;

export const down = `
DROP INDEX IF EXISTS ai_drafts_source_job_idx;
ALTER TABLE ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_source_job_fk;
DROP INDEX IF EXISTS ai_drafts_group_idx;
DROP INDEX IF EXISTS ai_drafts_one_approved_per_group;
DROP INDEX IF EXISTS ai_drafts_one_selected_per_group;
ALTER TABLE ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_one_target;
ALTER TABLE ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_approved_is_selected;
ALTER TABLE ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_discarded_not_selected;
ALTER TABLE ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_selected_meta;
ALTER TABLE ai_drafts DROP COLUMN IF EXISTS selected_at;
ALTER TABLE ai_drafts DROP COLUMN IF EXISTS selected_by;
ALTER TABLE ai_drafts DROP COLUMN IF EXISTS selection_status;
ALTER TABLE ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_group_fk;
ALTER TABLE ai_drafts DROP COLUMN IF EXISTS draft_group_id;
`;
