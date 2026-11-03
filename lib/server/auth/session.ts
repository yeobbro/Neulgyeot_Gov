import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "../../domain/enums";
import type { Db } from "../db/client";

export const SESSION_COOKIE = "ngm_session";
export const SESSION_MAX_AGE_SECONDS = 8 * 3600;

export type Actor = {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  email: string;
  roles: Role[];
  organizationId: string;
  organizationName: string;
  providerId: string | null;
  /** Region units this actor may see. `null` = whole tenant (admin / auditor statistics). */
  regionScope: string[] | null;
  canConfirmOfficialDetermination: boolean;
  isDemoAccount: boolean;
};

export const hasRole = (a: Actor, r: Role) => a.roles.includes(r);
export const primaryRole = (a: Actor): Role =>
  (["municipal_admin", "case_manager", "service_provider", "auditor"] as Role[]).find((r) => a.roles.includes(r)) ?? a.roles[0];

let warned = false;
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") {
    throw new Error("SESSION_SECRET (32+ chars) is required in production.");
  }
  if (process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.warn("[ngm] SESSION_SECRET not set: DEMO_MODE fallback secret in use. Not for real data.");
  }
  return "neulgyeot-municipality-dev-only-insecure-secret-change-me";
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function createSessionToken(userId: string, tenantId: string, now = Date.now()): string {
  const payload = b64(JSON.stringify({ uid: userId, tid: tenantId, exp: Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null, now = Date.now()): { uid: string; tid: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString()) as { uid?: string; tid?: string; exp?: number };
    if (!d.uid || !d.tid || !d.exp || d.exp * 1000 < now) return null;
    return { uid: d.uid, tid: d.tid };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
});

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * Loads the actor fresh from the DB (inside the tenant's RLS context) on
 * every request so deactivation and role changes apply immediately.
 */
export async function loadActor(tx: Db, userId: string): Promise<Actor | null> {
  const [u] = await tx.query<{
    id: string; tenant_id: string; tenant_name: string; display_name: string; email: string; organization_id: string;
    organization_name: string; provider_id: string | null; is_active: boolean; can_confirm: boolean; is_demo_account: boolean;
  }>(
    `SELECT u.id, u.tenant_id, t.name AS tenant_name, u.display_name, u.email, u.organization_id, o.name AS organization_name,
            u.provider_id, u.is_active, u.can_confirm_official_determination AS can_confirm, u.is_demo_account
       FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = $1`,
    [userId],
  );
  if (!u || !u.is_active) return null;
  const roles = (await tx.query<{ role: Role }>(`SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role`, [userId])).map((r) => r.role);
  if (roles.length === 0) return null;
  let regionScope: string[] | null = null;
  if (!roles.includes("municipal_admin")) {
    const rows = await tx.query<{ id: string }>(
      `WITH RECURSIVE tree AS (
         SELECT r.id FROM region_units r JOIN user_region_scopes s ON s.region_unit_id = r.id WHERE s.user_id = $1
         UNION SELECT c.id FROM region_units c JOIN tree t ON c.parent_id = t.id
       ) SELECT id FROM tree ORDER BY id`,
      [userId],
    );
    regionScope = rows.map((r) => r.id);
  }
  return {
    id: u.id,
    tenantId: u.tenant_id,
    tenantName: u.tenant_name,
    name: u.display_name,
    email: u.email,
    roles,
    organizationId: u.organization_id,
    organizationName: u.organization_name,
    providerId: u.provider_id,
    regionScope,
    canConfirmOfficialDetermination: u.can_confirm,
    isDemoAccount: u.is_demo_account,
  };
}

/** Demo login is off in production unless DEMO_MODE=true is set explicitly. */
export function demoLoginEnabled(): boolean {
  if (process.env.DEMO_LOGIN === "false") return false;
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.DEMO_MODE === "true";
}
