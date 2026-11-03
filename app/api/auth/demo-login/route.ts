import { getDb } from "@/lib/server/db/client";
import { sessionCookieOptions, SESSION_COOKIE } from "@/lib/server/auth/session";
import { assertCsrf, clientKey, errorResponse, json, parseBody, rateLimit } from "@/lib/server/http";
import { demoLogin, demoLoginBody } from "@/lib/server/services/auth";
import { cookies } from "next/headers";

export async function POST(req: Request) {
  try {
    assertCsrf(req);
    rateLimit(`demo-login:${clientKey(req)}`, 30, 60_000);
    const body = await parseBody(req, demoLoginBody);
    const { token, actor } = await demoLogin(await getDb(), body);
    (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
    return json({ ok: true, roles: actor.roles });
  } catch (e) {
    return errorResponse(e);
  }
}
