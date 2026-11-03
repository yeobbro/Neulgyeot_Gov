import { openDb, setDbForTesting, withTenant, type Db } from "../lib/server/db/client";
import { seed, DEMO_HOSPITAL_KEY_DEFAULT } from "../lib/server/db/seed";
import { createSessionToken, loadActor, SESSION_COOKIE } from "../lib/server/auth/session";
import { CSRF_HEADER, resetRateLimits } from "../lib/server/http";

export { DEMO_USERS, DEMO_TENANT, OTHER_TENANT } from "../lib/server/db/seed";
export const HOSPITAL_KEY = DEMO_HOSPITAL_KEY_DEFAULT;

export async function freshDb(): Promise<Db> {
  const db = await openDb({ url: null });
  await db.transaction((tx) => seed(tx));
  setDbForTesting(db);
  resetRateLimits();
  return db;
}

const TENANT_OF: Record<string, string> = { usr_nuri_admin: "tn_nuri" };
export function cookieFor(userId: string) {
  return `${SESSION_COOKIE}=${createSessionToken(userId, TENANT_OF[userId] ?? "tn_gaon")}`;
}

type Handler = (req: Request, ctx: any) => Promise<Response>;

export async function call(handler: Handler, opts: { method?: string; url?: string; as?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; csrf?: boolean }) {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost", ...(opts.headers ?? {}) };
  if (opts.as) headers.cookie = cookieFor(opts.as);
  if (method !== "GET" && opts.csrf !== false) headers[CSRF_HEADER] = "1";
  const req = new Request(`http://localhost${opts.url ?? "/api/test"}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

export async function asActor<T>(db: Db, userId: string, fn: (tx: Db, actor: NonNullable<Awaited<ReturnType<typeof loadActor>>>) => Promise<T>) {
  return withTenant(db, TENANT_OF[userId] ?? "tn_gaon", async (tx) => {
    const a = await loadActor(tx, userId);
    if (!a) throw new Error("no actor");
    return fn(tx, a);
  });
}

export function envelope(overrides: Record<string, any> = {}) {
  const base = {
    schemaVersion: "1.0",
    transferId: `SYN-TR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    eventType: "discharge-care-referral",
    source: { facilityId: "SYN-HOSP-01" },
    destination: { municipalityCode: "DEMO-GANGNAM" },
    subject: { patientId: "SYN-P-0101", name: "합성환자", birthDate: "1941-03-02", contact: null },
    discharge: { plannedDate: "2026-12-01" },
    clinicalSummary: { kAdl: { eating: "자립", mobility: "부분 도움", toileting: "자립" }, cognition: "일상 의사소통 가능" },
    livingNeeds: { livingArrangement: "독거", housingType: "단독주택", barriers: ["계단"], requestedServices: ["식사 지원"] },
    consent: {
      status: "DEMO_GRANTED", version: "1.0", recordedAt: "2026-11-01T10:00:00+09:00",
      scope: ["identity", "discharge", "kAdl", "cognition", "livingNeeds"], sensitiveInformationConsent: "granted", retention: "untilCaseClosure",
      legalBasis: "정보주체 별도 동의 (DEMO)", purpose: "통합돌봄 연계 검토",
    },
  };
  return { ...base, ...overrides };
}
export const authHeaders = (idem: string, key = HOSPITAL_KEY) => ({ authorization: `Bearer ${key}`, "idempotency-key": idem });
