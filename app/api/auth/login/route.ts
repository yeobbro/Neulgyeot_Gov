import { getDb } from "@/lib/server/db/client";
import { sessionCookieOptions, SESSION_COOKIE } from "@/lib/server/auth/session";
import { clientKey, errorResponse, json, parseBody, rateLimit } from "@/lib/server/http";
import { loginBody, passwordLogin } from "@/lib/server/services/auth";
import { cookies } from "next/headers";

export async function POST(req: Request) {
  try {
    rateLimit(`login:${clientKey(req)}`, 10, 60_000);
    const body = await parseBody(req, loginBody);
    const { token, actor } = await passwordLogin(await getDb(), body);
    (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
    return json({ ok: true, roles: actor.roles });
  } catch (e) {
    return errorResponse(e);
  }
}
