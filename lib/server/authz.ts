/**
 * Server-side authorization (RBAC + ABAC).
 *  - tenant: enforced by RLS (withTenant) — rows of other tenants are invisible.
 *  - role:   requireRole / permission helpers.
 *  - region: case managers only see cases inside their region scope.
 *  - assignment: case managers may only modify cases they are assigned to.
 *  - provider: provider users only see service referrals addressed to them.
 * Out-of-scope reads return 404 so other regions' records are not revealed.
 */
import type { Role } from "../domain/enums";
import type { Actor } from "./auth/session";
import { hasRole } from "./auth/session";
import type { Db } from "./db/client";
import { forbidden, notFound } from "./errors";

export function requireRole(actor: Actor, ...roles: Role[]) {
  if (!roles.some((r) => actor.roles.includes(r))) throw forbidden();
}

export const isAdmin = (a: Actor) => hasRole(a, "municipal_admin");
export const isCaseManager = (a: Actor) => hasRole(a, "case_manager");
export const isStaff = (a: Actor) => isAdmin(a) || isCaseManager(a);

/** SQL fragment restricting a region column to the actor's scope. */
export function regionScopeSql(actor: Actor, col: string, params: unknown[]): string {
  if (isAdmin(actor)) return "TRUE";
  if (isCaseManager(actor) && actor.regionScope?.length) {
    params.push(actor.regionScope);
    return `${col} = ANY($${params.length}::text[])`;
  }
  return "FALSE";
}

export type CaseAccess = { id: string; region_unit_id: string; status: string; assigned: boolean; version: number };

/** Read access to a case (staff). */
export async function assertCaseRead(tx: Db, actor: Actor, caseId: string): Promise<CaseAccess> {
  if (!isStaff(actor)) throw notFound("사례");
  const [c] = await tx.query<{ id: string; region_unit_id: string; status: string; version: number }>(
    `SELECT id, region_unit_id, status, version FROM care_cases WHERE id = $1`,
    [caseId],
  );
  if (!c) throw notFound("사례");
  if (!isAdmin(actor) && !actor.regionScope?.includes(c.region_unit_id)) throw notFound("사례");
  const [a] = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM case_assignments WHERE case_id = $1 AND user_id = $2 AND ended_at IS NULL`,
    [caseId, actor.id],
  );
  return { ...c, assigned: (a?.n ?? 0) > 0 };
}

/** Write access: admin, or a case manager who is actively assigned to the case. */
export async function assertCaseWrite(tx: Db, actor: Actor, caseId: string): Promise<CaseAccess> {
  const c = await assertCaseRead(tx, actor, caseId);
  if (isAdmin(actor) || c.assigned) return c;
  throw forbidden("배정된 담당자만 이 사례를 수정할 수 있습니다.");
}

export async function canApprovePlan(tx: Db, actor: Actor): Promise<boolean> {
  const [s] = await tx.query<{ plan_approval_roles: string[] }>(`SELECT plan_approval_roles FROM tenant_settings WHERE tenant_id = $1`, [actor.tenantId]);
  const roles = s?.plan_approval_roles ?? ["municipal_admin"];
  return actor.roles.some((r) => roles.includes(r));
}

/** Provider users: the service referral must be addressed to their organisation. */
export async function assertProviderReferral(tx: Db, actor: Actor, referralId: string) {
  if (!hasRole(actor, "service_provider") || !actor.providerId) throw notFound("의뢰");
  const [r] = await tx.query<{ id: string; status: string; provider_id: string; version: number }>(
    `SELECT id, status, provider_id, version FROM service_referrals WHERE id = $1`,
    [referralId],
  );
  if (!r || r.provider_id !== actor.providerId || r.status === "DRAFT") throw notFound("의뢰");
  return r;
}
