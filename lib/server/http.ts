import { z } from "zod";
import { loadActor, readCookie, SESSION_COOKIE, verifySessionToken, type Actor } from "./auth/session";
import { audit } from "./audit";
import { getDb, withTenant, type Db } from "./db/client";
import { AppError, invalid } from "./errors";

export type Ctx<P> = { req: Request; params: P; tx: Db; actor: Actor };
type RouteContext = { params: Promise<Record<string, string>> };

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) return json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  if (err instanceof z.ZodError) {
    return json({ error: { code: "validation_error", message: "입력값을 확인해 주세요.", details: z.flattenError(err) } }, 400);
  }
  // Log the error type only: DB driver messages can echo row content.
  console.error("[ngm] unhandled:", err instanceof Error ? `${err.name}: ${err.message.slice(0, 160)}` : typeof err);
  return json({ error: { code: "internal_error", message: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." } }, 500);
}

export const CSRF_HEADER = "x-ngm-csrf";

/**
 * CSRF defence for cookie-authenticated mutations: SameSite=Lax cookie +
 * a custom header (cannot be sent cross-origin without a CORS preflight,
 * which this app never grants) + Origin check when the header is present.
 */
export function assertCsrf(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.headers.get(CSRF_HEADER) !== "1") throw new AppError("forbidden", "요청 검증에 실패했습니다. (CSRF)");
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    try {
      if (new URL(origin).host !== host) throw new AppError("forbidden", "허용되지 않은 출처의 요청입니다.");
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("forbidden", "허용되지 않은 출처의 요청입니다.");
    }
  }
}

/** Authenticated staff/provider route: CSRF → session → tenant-scoped RLS transaction. */
export function route<P extends Record<string, string> = Record<string, never>>(handler: (ctx: Ctx<P>) => Promise<unknown>) {
  return async (req: Request, context?: RouteContext): Promise<Response> => {
    let denied: { actor: Actor; err: AppError } | null = null;
    try {
      assertCsrf(req);
      const session = verifySessionToken(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
      if (!session) throw new AppError("unauthenticated", "로그인이 필요합니다.");
      const db = await getDb();
      const params = ((await context?.params) ?? {}) as P;
      const result = await withTenant(db, session.tid, async (tx) => {
        const actor = await loadActor(tx, session.uid);
        if (!actor) throw new AppError("unauthenticated", "세션이 만료되었거나 비활성화된 계정입니다.");
        try {
          return await handler({ req, params, tx, actor });
        } catch (e) {
          if (e instanceof AppError && (e.code === "forbidden" || e.code === "not_found")) denied = { actor, err: e };
          throw e;
        }
      });
      return result instanceof Response ? result : json(result);
    } catch (err) {
      const d = denied as { actor: Actor; err: AppError } | null;
      if (d) await recordDenied(d.actor, req, d.err).catch(() => undefined);
      return errorResponse(err);
    }
  };
}

async function recordDenied(actor: Actor, req: Request, err: AppError) {
  const db = await getDb();
  await withTenant(db, actor.tenantId, (tx) =>
    audit(tx, actor, "access.denied", { type: "route", id: new URL(req.url).pathname.slice(0, 120) }, "denied", { code: err.code, method: req.method }),
  );
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw invalid("JSON 본문을 읽을 수 없습니다.");
  }
  return schema.parse(body);
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(new URL(req.url).searchParams.entries()));
}

const buckets = new Map<string, { count: number; resetAt: number }>();
/**
 * Fixed-window limiter. Per server instance only — production should use a
 * shared store (e.g. Redis / platform firewall rules). Documented in SECURITY.md.
 */
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > limit) throw new AppError("rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
}
export const resetRateLimits = () => buckets.clear();

export function clientKey(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
}
