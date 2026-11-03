import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Role } from "../domain/enums";
import { loadActor, SESSION_COOKIE, verifySessionToken, type Actor } from "./auth/session";
import { getDb, withTenant, type Db } from "./db/client";
import { AppError } from "./errors";

/** Server-component data access: same session, RLS and service-layer checks as the API. */
export async function withPage<T>(fn: (tx: Db, actor: Actor) => Promise<T>, opts: { roles?: Role[] } = {}): Promise<T> {
  const session = verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  const db = await getDb();
  try {
    return await withTenant(db, session.tid, async (tx) => {
      const actor = await loadActor(tx, session.uid);
      if (!actor) throw new AppError("unauthenticated", "세션 만료");
      if (opts.roles && !opts.roles.some((r) => actor.roles.includes(r))) throw new AppError("forbidden", "권한 없음");
      return fn(tx, actor);
    });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "unauthenticated") redirect("/login?expired=1");
      if (e.code === "not_found") notFound();
      if (e.code === "forbidden") redirect("/forbidden");
    }
    throw e;
  }
}

export async function currentActor(): Promise<Actor | null> {
  const session = verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const db = await getDb();
  return withTenant(db, session.tid, (tx) => loadActor(tx, session.uid));
}
