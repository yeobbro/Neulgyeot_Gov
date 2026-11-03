import type { Actor } from "./auth/session";
import { primaryRole } from "./auth/session";
import type { Db } from "./db/client";
import { newId } from "./db/ids";

export const AUDIT_ACTIONS = [
  "auth.login", "auth.login_failed", "auth.logout",
  "user.role_change", "user.deactivate", "user.activate",
  "recipient.view", "recipient.identity_view", "case.view", "case.list",
  "record.create", "record.update", "record.delete",
  "referral.receive", "referral.reject", "referral.duplicate", "referral.view", "referral.status_change", "referral.assign",
  "referral.consent_review", "referral.resubmit", "referral.callback",
  "assessment.save", "assessment.confirm",
  "plan.save", "plan.status_change", "plan.approve",
  "meeting.create", "meeting.record",
  "service_referral.create", "service_referral.status_change",
  "monitoring.create", "case.status_change", "case.close", "case.assign",
  "task.update", "provider.capacity_update", "provider.public_directory_import", "provider.public_directory_verified", "provider.public_directory_verification_revoked",
  "export.csv", "export.print",
  "ai.generate", "ai.approve", "ai.discard",
  "settings.update", "access.denied",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

type Meta = Record<string, string | number | boolean | null | string[]>;

const PII_KEYS = /name|birth|phone|contact|address|body|note|text|diagnos|medication/i;

/** Defensive: strip keys that look like personal data so audit rows stay metadata-only. */
export function sanitizeMeta(meta: Meta = {}): Meta {
  const out: Meta = {};
  for (const [k, v] of Object.entries(meta)) if (!PII_KEYS.test(k)) out[k] = v;
  return out;
}

export async function audit(
  tx: Db,
  actor: Actor | null,
  action: AuditAction,
  entity: { type?: string; id?: string | null } = {},
  outcome: "success" | "denied" | "failure" = "success",
  meta?: Meta,
  tenantIdOverride?: string | null,
) {
  await tx.query(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_role, action, entity_type, entity_id, outcome, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId("aud"),
      tenantIdOverride !== undefined ? tenantIdOverride : actor?.tenantId ?? null,
      actor?.id ?? null,
      actor ? primaryRole(actor) : null,
      action,
      entity.type ?? null,
      entity.id ?? null,
      outcome,
      JSON.stringify(sanitizeMeta(meta)),
    ],
  );
}
