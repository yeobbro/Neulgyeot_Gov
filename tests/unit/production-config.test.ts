/** Deployment configuration: env checker (never echoes values) and the persistent-DB session/demo hardening. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createSessionToken, demoLoginEnabled, verifySessionToken } from "../../lib/server/auth/session";
import { checkEnv } from "../../lib/server/config/env-check";

const SECRET = "x".repeat(40);
const errs = (env: Record<string, string>, p: Parameters<typeof checkEnv>[1]) => checkEnv(env, p).filter((f) => f.level === "error").map((f) => f.key);
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["NODE_ENV", "DATABASE_URL", "DEMO_MODE", "DEMO_LOGIN", "SESSION_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const setEnv = (e: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = v;
  }
};

test("env check: the current Vercel demo configuration passes the demo profile", () => {
  assert.deepEqual(errs({ DEMO_MODE: "true", AI_FEATURE_ENABLED: "false" }, "demo"), []);
});

test("env check: production refuses demo settings, missing/weak/fallback secrets, local or unencrypted DBs", () => {
  assert.deepEqual(errs({ DEMO_MODE: "true" }, "production").sort(), ["DATABASE_URL", "DEMO_MODE", "SESSION_SECRET"].sort());
  const base = { DATABASE_URL: "postgres://app:pw@db-pooler.example.org:6543/gov", SESSION_SECRET: SECRET };
  assert.deepEqual(errs(base, "production"), []);
  assert.ok(errs({ ...base, SESSION_SECRET: "short" }, "production").includes("SESSION_SECRET"));
  assert.ok(errs({ ...base, SESSION_SECRET: "neulgyeot-municipality-dev-only-insecure-secret-change-me" }, "production").includes("SESSION_SECRET"));
  assert.ok(errs({ ...base, DATABASE_URL: "postgres://app:pw@127.0.0.1:5432/gov" }, "production").includes("DATABASE_URL"));
  assert.ok(errs({ ...base, DATABASE_URL: "postgres://app:pw@db.example.org/gov?sslmode=disable" }, "production").includes("DATABASE_URL"));
  for (const k of ["DEMO_LOGIN", "DEMO_SEED", "ALLOW_DEMO_SEED", "ALLOW_DB_RESET"]) assert.ok(errs({ ...base, [k]: "true" }, "production").includes(k), k);
  assert.ok(errs({ ...base, DATABASE_SSL_REJECT_UNAUTHORIZED: "false" }, "production").includes("DATABASE_SSL_REJECT_UNAUTHORIZED"));
  assert.ok(errs({ ...base, DATABASE_URL: "mysql://x" }, "production").includes("DATABASE_URL"));
});

test("env check: AI provider and worker settings (per-tenant tokens, https, lease > timeout)", () => {
  const w = { AI_WORKER_ENABLED: "true", DATABASE_URL: "postgres://w:pw@db.example.org/gov", AI_PROVIDER: "ai_intelligence", AI_INTELLIGENCE_URL: "https://ai.internal.example", AI_INTELLIGENCE_TENANT_TOKENS: JSON.stringify({ tn_a: "a".repeat(24), tn_b: "b".repeat(24) }) };
  assert.deepEqual(errs(w, "worker"), []);
  assert.ok(errs({ ...w, AI_INTELLIGENCE_URL: "http://ai.example.org" }, "worker").includes("AI_INTELLIGENCE_URL"));
  assert.deepEqual(errs({ ...w, AI_INTELLIGENCE_URL: "http://127.0.0.1:8810" }, "worker"), [], "http allowed for localhost");
  assert.ok(errs({ ...w, AI_INTELLIGENCE_TENANT_TOKENS: JSON.stringify({ tn_a: "s".repeat(20), tn_b: "s".repeat(20) }) }, "worker").includes("AI_INTELLIGENCE_TENANT_TOKENS"), "shared token");
  assert.ok(errs({ ...w, AI_INTELLIGENCE_TENANT_TOKENS: "not json" }, "worker").includes("AI_INTELLIGENCE_TENANT_TOKENS"));
  assert.ok(errs({ ...w, AI_WORKER_LEASE_SECONDS: "60", AI_WORKER_JOB_TIMEOUT_MS: "300000" }, "worker").includes("AI_WORKER_LEASE_SECONDS"));
  assert.ok(errs({ ...w, AI_WORKER_ENABLED: "false" }, "worker").includes("AI_WORKER_ENABLED"));
  const web = checkEnv({ DEMO_MODE: "true", AI_INTELLIGENCE_TENANT_TOKENS: "{}" }, "demo");
  assert.ok(web.some((f) => f.key === "AI_INTELLIGENCE_TENANT_TOKENS" && f.level === "warn"), "tokens do not belong in the web app");
});

test("env check never returns a value", () => {
  const secretValues = ["pw-VERY-SECRET-123", "tok-SECRET-tenant-a-0001", "s3cr3t-session-value-of-forty-characters!!"];
  const out = JSON.stringify([
    checkEnv({ DATABASE_URL: `postgres://u:${secretValues[0]}@db.example.org/x`, SESSION_SECRET: secretValues[2], AI_PROVIDER: "ai_intelligence", AI_INTELLIGENCE_URL: "https://ai.example", AI_INTELLIGENCE_TENANT_TOKENS: JSON.stringify({ tn: secretValues[1] }) }, "production"),
    checkEnv({ DATABASE_URL: `postgres://u:${secretValues[0]}@db.example.org/x`, AI_WORKER_ENABLED: "true", AI_INTELLIGENCE_URL: "https://ai.example", AI_INTELLIGENCE_TENANT_TOKENS: JSON.stringify({ tn: secretValues[1] }) }, "worker"),
  ]);
  for (const v of secretValues) assert.ok(!out.includes(v), "value leaked");
  assert.ok(!out.includes("db.example.org"), "host not echoed");
});

test("session hardening: with a persistent DB in production, the public fallback secret is refused even with DEMO_MODE", () => {
  setEnv({ NODE_ENV: "production", DEMO_MODE: "true", SESSION_SECRET: undefined, DATABASE_URL: undefined });
  const t = createSessionToken("u1", "tn"); // in-memory demo: fallback tolerated (current Vercel setup)
  assert.equal(verifySessionToken(t)?.uid, "u1");
  setEnv({ DATABASE_URL: "postgres://u:p@db.example.org/x" });
  assert.throws(() => createSessionToken("u1", "tn"), /SESSION_SECRET/);
  assert.throws(() => verifySessionToken(t), /SESSION_SECRET/, "fails closed: no request is authenticated with the public secret");
  setEnv({ SESSION_SECRET: SECRET });
  assert.equal(verifySessionToken(createSessionToken("u2", "tn"))?.uid, "u2");
  assert.equal(verifySessionToken(t), null, "tokens signed with the fallback secret are rejected");
});

test("session hardening: demo login on a persistent production DB needs an explicit opt-in", () => {
  setEnv({ NODE_ENV: "production", DEMO_MODE: "true", DATABASE_URL: undefined, DEMO_LOGIN: undefined });
  assert.equal(demoLoginEnabled(), true, "in-memory demo (current Vercel setup) unchanged");
  setEnv({ DATABASE_URL: "postgres://u:p@db.example.org/x" });
  assert.equal(demoLoginEnabled(), false, "DEMO_MODE alone is not enough with a persistent DB");
  setEnv({ DEMO_LOGIN: "true" });
  assert.equal(demoLoginEnabled(), true, "explicit opt-in (synthetic staging only)");
  setEnv({ DEMO_MODE: undefined });
  assert.equal(demoLoginEnabled(), false);
  setEnv({ NODE_ENV: "test", DATABASE_URL: undefined, DEMO_LOGIN: undefined });
  assert.equal(demoLoginEnabled(), true, "development/test unchanged");
});
