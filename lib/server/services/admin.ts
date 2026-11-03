import { z } from "zod";
import { ROLES } from "../../domain/enums";
import { TRANSFER_CATEGORIES } from "../../integrations/hospital/schema";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { requireRole } from "../authz";
import type { Db } from "../db/client";
import { forbidden, invalid, notFound } from "../errors";

export async function listUsers(tx: Db, actor: Actor) {
  requireRole(actor, "municipal_admin");
  return tx.query(
    `SELECT u.id, u.display_name, u.email, u.is_active, u.is_demo_account, u.last_login_at, o.name AS org,
            (SELECT array_agg(role ORDER BY role) FROM user_roles r WHERE r.user_id = u.id) AS roles,
            (SELECT array_agg(rg.name ORDER BY rg.name) FROM user_region_scopes s JOIN region_units rg ON rg.id = s.region_unit_id WHERE s.user_id = u.id) AS regions
       FROM users u JOIN organizations o ON o.id = u.organization_id ORDER BY u.display_name`,
  );
}

export const userActiveBody = z.object({ active: z.boolean() });
export async function setUserActive(tx: Db, actor: Actor, userId: string, b: z.infer<typeof userActiveBody>) {
  requireRole(actor, "municipal_admin");
  if (userId === actor.id) throw forbidden("본인 계정은 비활성화할 수 없습니다.");
  const rows = await tx.query(`UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id`, [userId, b.active]);
  if (!rows.length) throw notFound("사용자");
  await audit(tx, actor, b.active ? "user.activate" : "user.deactivate", { type: "user", id: userId }, "success");
  return { ok: true };
}

export const userRolesBody = z.object({ roles: z.array(z.enum(ROLES)).min(1).max(4) });
export async function setUserRoles(tx: Db, actor: Actor, userId: string, b: z.infer<typeof userRolesBody>) {
  requireRole(actor, "municipal_admin");
  if (userId === actor.id && !b.roles.includes("municipal_admin")) throw invalid("본인의 관리자 권한은 제거할 수 없습니다.");
  const [u] = await tx.query<{ provider_id: string | null }>(`SELECT provider_id FROM users WHERE id = $1`, [userId]);
  if (!u) throw notFound("사용자");
  if (b.roles.includes("service_provider") && !u.provider_id) throw invalid("제공기관 소속이 없는 사용자에게 제공기관 역할을 줄 수 없습니다.");
  await tx.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
  for (const r of b.roles) await tx.query(`INSERT INTO user_roles (tenant_id, user_id, role, granted_by) VALUES ($1,$2,$3,$4)`, [actor.tenantId, userId, r, actor.id]);
  await audit(tx, actor, "user.role_change", { type: "user", id: userId }, "success", { roles: b.roles });
  return { ok: true };
}

export async function getSettings(tx: Db, actor: Actor) {
  requireRole(actor, "municipal_admin");
  const [s] = await tx.query(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [actor.tenantId]);
  const catalog = await tx.query(`SELECT service_type, name, department, is_active FROM service_catalog ORDER BY service_type`);
  return { settings: s, catalog };
}

export const settingsBody = z.object({
  monitoringIntervalDays: z.number().int().min(7).max(180),
  planApprovalRoles: z.array(z.enum(["municipal_admin", "case_manager"])).min(1),
  intakeAllowedCategories: z.array(z.enum(TRANSFER_CATEGORIES)).min(1),
  aiEnabled: z.boolean(),
  capacityFreshDays: z.number().int().min(1).max(90),
});
export async function updateSettings(tx: Db, actor: Actor, b: z.infer<typeof settingsBody>) {
  requireRole(actor, "municipal_admin");
  if (!b.intakeAllowedCategories.includes("identity")) throw invalid("기본 식별정보는 수신 항목에서 제외할 수 없습니다.");
  await tx.query(
    `UPDATE tenant_settings SET monitoring_interval_days=$2, plan_approval_roles=$3, intake_allowed_categories=$4, ai_enabled=$5, capacity_fresh_days=$6, updated_at=now() WHERE tenant_id=$1`,
    [actor.tenantId, b.monitoringIntervalDays, b.planApprovalRoles, b.intakeAllowedCategories, b.aiEnabled, b.capacityFreshDays],
  );
  await audit(tx, actor, "settings.update", { type: "tenant_settings", id: actor.tenantId }, "success", { aiEnabled: b.aiEnabled, categories: b.intakeAllowedCategories });
  return { ok: true };
}

export async function listCaseManagers(tx: Db) {
  return tx.query<{ id: string; display_name: string; regions: string[] }>(
    `SELECT u.id, u.display_name, coalesce((SELECT array_agg(s.region_unit_id) FROM user_region_scopes s WHERE s.user_id = u.id), '{}') AS regions
       FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'case_manager' WHERE u.is_active ORDER BY u.display_name`,
  );
}
export async function listRegions(tx: Db) {
  return tx.query<{ id: string; name: string; level: string; parent_id: string | null }>(`SELECT id, name, level, parent_id FROM region_units ORDER BY code`);
}
