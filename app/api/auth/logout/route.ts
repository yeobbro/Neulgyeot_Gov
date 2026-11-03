import { SESSION_COOKIE } from "@/lib/server/auth/session";
import { audit } from "@/lib/server/audit";
import { json, route } from "@/lib/server/http";
import { cookies } from "next/headers";

export const POST = route(async ({ tx, actor }) => {
  await audit(tx, actor, "auth.logout", { type: "user", id: actor.id });
  (await cookies()).delete(SESSION_COOKIE);
  return json({ ok: true });
});
