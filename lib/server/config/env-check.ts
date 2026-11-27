/**
 * Deployment configuration check. Reports problems WITHOUT ever returning or printing a value: only names, whether a
 * variable is set, lengths, URL scheme/host class and counts. Used by scripts/check-env.mts and unit tests.
 *
 * Profiles:
 *   demo        — synthetic in-memory demo (current Vercel Production/Preview)
 *   staging     — persistent PostgreSQL with synthetic data only
 *   production  — persistent PostgreSQL with real data
 *   worker      — the standalone AI worker process (scripts/ai-worker.mts)
 */
export type Profile = "demo" | "staging" | "production" | "worker";
export type Finding = { level: "error" | "warn" | "ok"; key: string; message: string };
type Env = Record<string, string | undefined>;

const KNOWN_FALLBACK_SECRET = "neulgyeot-municipality-dev-only-insecure-secret-change-me";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const set = (v: string | undefined) => typeof v === "string" && v.length > 0;

function dbUrlInfo(url: string) {
  try {
    const u = new URL(url);
    return {
      ok: u.protocol === "postgres:" || u.protocol === "postgresql:",
      local: LOCAL_HOSTS.has(u.hostname.replace(/^\[|\]$/g, "")),
      sslDisabled: /(^|&)sslmode=disable(&|$)/.test(u.search.slice(1)),
      hasPassword: u.password.length > 0,
      pooled: /pooler|pgbouncer|-pooler\.|:6543$/.test(u.host) || /(^|&)pgbouncer=true(&|$)/.test(u.search.slice(1)),
    };
  } catch {
    return null;
  }
}

export function checkEnv(env: Env, profile: Profile): Finding[] {
  const f: Finding[] = [];
  const add = (level: Finding["level"], key: string, message: string) => f.push({ level, key, message });
  const persistent = profile === "staging" || profile === "production" || profile === "worker";

  // ---------------------------------------------------------------- database
  if (!set(env.DATABASE_URL)) {
    if (persistent) add("error", "DATABASE_URL", `required for profile "${profile}" (without it the app uses the in-memory demo DB)`);
    else add("ok", "DATABASE_URL", "not set → in-memory demo DB (non-persistent, per instance)");
  } else {
    const i = dbUrlInfo(env.DATABASE_URL!);
    if (!i?.ok) add("error", "DATABASE_URL", "is not a postgres:// URL");
    else {
      if (profile === "demo") add("error", "DATABASE_URL", "set for profile demo: the deployment would be persistent, not a demo");
      if ((profile === "production" || profile === "staging") && i.local) add("error", "DATABASE_URL", "points to a local host");
      if (profile === "production" && i.sslDisabled) add("error", "DATABASE_URL", "sslmode=disable is not allowed in production");
      if (!i.hasPassword && !i.local) add("warn", "DATABASE_URL", "has no password component (expected for managed PostgreSQL)");
      if ((profile === "production" || profile === "staging") && !i.pooled) add("warn", "DATABASE_URL", "does not look like a pooled endpoint; serverless functions should use the provider's transaction pooler");
      if (!f.some((x) => x.key === "DATABASE_URL" && x.level === "error")) add("ok", "DATABASE_URL", `set (${i.local ? "local" : "remote"} host${i.pooled ? ", pooled" : ""})`);
    }
  }
  const pool = Number(env.DATABASE_POOL_MAX ?? 5);
  if (!Number.isInteger(pool) || pool < 1 || pool > 50) add("error", "DATABASE_POOL_MAX", "must be an integer 1–50");
  else if (profile !== "worker" && pool > 10) add("warn", "DATABASE_POOL_MAX", `${pool} connections per serverless instance can exhaust the database; 1–5 recommended behind a pooler`);
  if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === "false" && profile === "production") add("error", "DATABASE_SSL_REJECT_UNAUTHORIZED", "certificate verification must stay on in production");

  // ---------------------------------------------------------------- sessions / demo
  if (profile !== "worker") {
    const s = env.SESSION_SECRET;
    if (!set(s)) {
      if (persistent) add("error", "SESSION_SECRET", "required (32+ chars); the public fallback secret is refused with a persistent DB");
      else add("warn", "SESSION_SECRET", "not set → public fallback secret (acceptable only for the synthetic in-memory demo)");
    } else if (s === KNOWN_FALLBACK_SECRET) add("error", "SESSION_SECRET", "equals the public fallback secret from the repository");
    else if (s!.length < 32) add("error", "SESSION_SECRET", `too short (${s!.length} < 32)`);
    else add("ok", "SESSION_SECRET", `set (${s!.length} chars)`);

    if (profile === "production") {
      if (env.DEMO_MODE === "true") add("error", "DEMO_MODE", "must not be true in production (synthetic data banner, demo fallbacks)");
      if (env.DEMO_LOGIN === "true") add("error", "DEMO_LOGIN", "password-less demo accounts must not be enabled in production");
      if (env.DEMO_SEED === "true") add("error", "DEMO_SEED", "would seed synthetic demo data into the production database");
      if (env.ALLOW_DEMO_SEED === "true") add("error", "ALLOW_DEMO_SEED", "must not be set in production");
    }
    if (profile === "staging" && env.DEMO_LOGIN === "true") add("warn", "DEMO_LOGIN", "demo accounts on a persistent DB: synthetic data only");
    if (profile === "demo" && env.DEMO_MODE !== "true") add("error", "DEMO_MODE", "must be true for the demo profile");
    if (env.ALLOW_DB_RESET === "true") add("error", "ALLOW_DB_RESET", "must never be set in a deployed environment");
  }

  // ---------------------------------------------------------------- AI
  for (const legacy of ["ANTHROPIC_API_KEY", "AI_FEATURE_ENABLED", "AI_MODEL"]) {
    if (set(env[legacy]) && !(legacy === "AI_FEATURE_ENABLED" && env[legacy] === "false")) add("warn", legacy, "legacy variable: the external LLM path was removed, this has no effect — remove it");
  }
  const aiOn = env.AI_PROVIDER === "ai_intelligence";
  if (profile === "worker" && env.AI_WORKER_ENABLED !== "true") add("error", "AI_WORKER_ENABLED", "the worker refuses to start unless this is 'true'");
  if (profile !== "worker" && set(env.AI_INTELLIGENCE_TENANT_TOKENS)) add("warn", "AI_INTELLIGENCE_TENANT_TOKENS", "only the worker calls the AI service; keep tokens out of the web app environment");
  if (aiOn || profile === "worker") {
    if (!set(env.AI_INTELLIGENCE_URL)) add("error", "AI_INTELLIGENCE_URL", "required when AI_PROVIDER=ai_intelligence");
    else {
      try {
        const u = new URL(env.AI_INTELLIGENCE_URL!);
        const local = LOCAL_HOSTS.has(u.hostname.replace(/^\[|\]$/g, ""));
        if (u.protocol !== "https:" && !local) add("error", "AI_INTELLIGENCE_URL", "must use https (http only for localhost)");
        else add("ok", "AI_INTELLIGENCE_URL", `set (${u.protocol.replace(":", "")}, ${local ? "local" : "remote"} host)`);
      } catch {
        add("error", "AI_INTELLIGENCE_URL", "is not a URL");
      }
    }
    let tokens: unknown = null;
    try {
      tokens = JSON.parse(env.AI_INTELLIGENCE_TENANT_TOKENS ?? "");
    } catch {
      /* reported below */
    }
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) add("error", "AI_INTELLIGENCE_TENANT_TOKENS", 'must be a JSON object {"tenantId": "token"}');
    else {
      const entries = Object.entries(tokens as Record<string, unknown>);
      const bad = entries.filter(([, v]) => typeof v !== "string" || v.length < 16).length;
      const dup = entries.length - new Set(entries.map(([, v]) => v)).size;
      if (!entries.length) add("error", "AI_INTELLIGENCE_TENANT_TOKENS", "no tenant tokens");
      if (bad) add("error", "AI_INTELLIGENCE_TENANT_TOKENS", `${bad} token(s) are not strings of 16+ chars`);
      if (dup) add("error", "AI_INTELLIGENCE_TENANT_TOKENS", "the same token is used for several tenants (tokens must be per tenant)");
      if (entries.length && !bad && !dup) add("ok", "AI_INTELLIGENCE_TENANT_TOKENS", `${entries.length} tenant token(s)`);
    }
  } else add("ok", "AI_PROVIDER", "rules only (no AI service configured)");
  if (profile === "worker") {
    const lease = Number(env.AI_WORKER_LEASE_SECONDS ?? 600) * 1000;
    const timeout = Number(env.AI_WORKER_JOB_TIMEOUT_MS ?? 300_000);
    if (!(lease > timeout)) add("error", "AI_WORKER_LEASE_SECONDS", "must exceed AI_WORKER_JOB_TIMEOUT_MS");
  }
  return f;
}
