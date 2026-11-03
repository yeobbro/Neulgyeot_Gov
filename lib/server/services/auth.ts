import { z } from "zod";
import type { Role } from "../../domain/enums";
import { verifyPassword } from "../auth/password";
import { createSessionToken, demoLoginEnabled, loadActor, type Actor } from "../auth/session";
import { audit } from "../audit";
import { withTenant, type Db } from "../db/client";
import { AppError } from "../errors";

export const loginBody = z.object({ email: z.string().trim().toLowerCase().email().max(120), password: z.string().min(1).max(200) });
export const demoLoginBody = z.object({ userId: z.string().min(3).max(60) });

type UserRow = { id: string; tenant_id: string; password_hash: string | null; is_active: boolean; is_demo_account: boolean };

/** Owner-connection lookup: the tenant is not known before authentication. */
async function findUser(db: Db, where: "email" | "id", value: string) {
  const [u] = await db.query<UserRow>(`SELECT id, tenant_id, password_hash, is_active, is_demo_account FROM users WHERE ${where} = $1`, [value]);
  return u ?? null;
}

async function finish(db: Db, u: UserRow, method: string): Promise<{ token: string; actor: Actor }> {
  return withTenant(db, u.tenant_id, async (tx) => {
    const actor = await loadActor(tx, u.id);
    if (!actor) throw new AppError("unauthenticated", "로그인할 수 없는 계정입니다.");
    await tx.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    await audit(tx, actor, "auth.login", { type: "user", id: u.id }, "success", { method });
    return { token: createSessionToken(u.id, u.tenant_id), actor };
  });
}

async function fail(db: Db, u: UserRow | null, reason: string) {
  await db.query(`INSERT INTO audit_logs (id, tenant_id, actor_id, action, outcome, meta) VALUES ($1,$2,$3,'auth.login_failed','failure',$4)`, [
    `aud_${crypto.randomUUID()}`, u?.tenant_id ?? null, u?.id ?? null, JSON.stringify({ reason }),
  ]);
}

export async function passwordLogin(db: Db, body: z.infer<typeof loginBody>) {
  const u = await findUser(db, "email", body.email);
  const ok = u ? await verifyPassword(body.password, u.password_hash) : await verifyPassword(body.password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  if (!u || !ok) {
    await fail(db, u, "bad_credentials");
    throw new AppError("unauthenticated", "이메일 또는 비밀번호가 올바르지 않습니다.");
  }
  if (!u.is_active) {
    await fail(db, u, "inactive");
    throw new AppError("unauthenticated", "비활성화된 계정입니다. 관리자에게 문의하세요.");
  }
  if (u.is_demo_account && !demoLoginEnabled()) {
    await fail(db, u, "demo_disabled");
    throw new AppError("unauthenticated", "운영 환경에서는 데모 계정을 사용할 수 없습니다.");
  }
  return finish(db, u, "password");
}

/** Demo account picker — development / demo deployments only. */
export async function demoLogin(db: Db, body: z.infer<typeof demoLoginBody>) {
  if (!demoLoginEnabled()) throw new AppError("forbidden", "데모 로그인이 비활성화되어 있습니다.");
  const u = await findUser(db, "id", body.userId);
  if (!u || !u.is_demo_account) throw new AppError("unauthenticated", "데모 계정을 찾을 수 없습니다.");
  if (!u.is_active) {
    await fail(db, u, "inactive");
    throw new AppError("unauthenticated", "비활성화된 계정입니다.");
  }
  return finish(db, u, "demo");
}

export async function listDemoAccounts(db: Db) {
  if (!demoLoginEnabled()) return [];
  return db.query<{ id: string; display_name: string; email: string; tenant_name: string; org: string; roles: Role[]; is_active: boolean }>(
    `SELECT u.id, u.display_name, u.email, t.name AS tenant_name, o.name AS org, array_agg(r.role ORDER BY r.role) AS roles, u.is_active
       FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN organizations o ON o.id = u.organization_id JOIN user_roles r ON r.user_id = u.id
      WHERE u.is_demo_account GROUP BY u.id, t.name, o.name ORDER BY t.name, u.id`,
  );
}

/**
 * External IdP / institutional SSO hook. Not implemented in the MVP: an
 * adapter must map a verified IdP subject to `users.id` and then call the
 * same session issuance as `finish`. See docs/SECURITY.md.
 */
export interface IdentityProviderAdapter {
  readonly name: string;
  resolveUser(assertion: unknown): Promise<{ userId: string } | null>;
}
