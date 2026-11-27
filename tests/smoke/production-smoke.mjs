/**
 * READ-ONLY smoke test for a deployed environment (default: Production).
 *   SMOKE_BASE_URL=https://neulgyeot-municipality.vercel.app npm run test:smoke
 *
 * Safety rules enforced in code:
 *  - The browser aborts every non-GET request except the demo login (and records it as a failure).
 *  - Direct API checks are GET only.
 *  - Signed-in pages are visited ONLY if /api/health reports demoMode=true AND storage.persistent=false, i.e. the
 *    deployment serves synthetic in-memory demo data. A persistent (real) database is never signed into.
 *  - Nothing is clicked except the demo-account buttons on /login. No draft generation, approval, assignment.
 * Output: JSON report + screenshots in SMOKE_OUT (default ./smoke-results), exit 1 on any failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.env.SMOKE_BASE_URL ?? "https://neulgyeot-municipality.vercel.app").replace(/\/$/, "");
const OUT = process.env.SMOKE_OUT ?? "smoke-results";
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, startedAt: new Date().toISOString(), health: null, checks: [], blockedWrites: [], consoleErrors: [], pageErrors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ------------------------------------------------------------------ anonymous HTTP checks (GET only) */
const get = (path, init = {}) => fetch(BASE + path, { redirect: "manual", ...init });
const h = await get("/api/health");
const health = await h.json().catch(() => null);
report.health = health;
check("GET /api/health 200", h.status === 200, JSON.stringify(health));
check("health reports db ok", health?.db === "ok");
for (const [path, expect] of [["/", [307, 308]], ["/dashboard", [307, 308]], ["/login", [200]], ["/forbidden", [200]], ["/this-page-does-not-exist", [404]]]) {
  const r = await get(path);
  check(`GET ${path} → ${expect.join("/")}`, expect.includes(r.status), `got ${r.status}${r.headers.get("location") ? ` → ${r.headers.get("location")}` : ""}`);
}
for (const path of ["/api/referrals", "/api/cases", "/api/dashboard", "/api/providers", "/api/ai/drafts?caseId=case_3", "/api/admin/ai-metrics"]) {
  const r = await get(path);
  check(`anonymous GET ${path} → 401`, r.status === 401, `got ${r.status}`);
}
const lh = await get("/login");
for (const header of ["content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy"]) {
  check(`security header ${header}`, Boolean(lh.headers.get(header)));
}

/* ------------------------------------------------------------------ browser checks */
const demo = health?.demoMode === true && health?.storage?.persistent === false;
check("signed-in checks allowed (demo + non-persistent synthetic data)", true, demo ? "yes" : "no — skipped, persistent or non-demo deployment");
const browser = await chromium.launch();

async function session(viewport, tag) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "GET" || req.method() === "HEAD" || (req.method() === "POST" && new URL(req.url()).pathname === "/api/auth/demo-login")) return route.continue();
    report.blockedWrites.push(`${tag} ${req.method()} ${new URL(req.url()).pathname}`);
    return route.abort();
  });
  page.on("console", (m) => m.type() === "error" && report.consoleErrors.push(`${tag} ${page.url().replace(BASE, "")}: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => report.pageErrors.push(`${tag} ${page.url().replace(BASE, "")}: ${String(e).slice(0, 200)}`));
  return { ctx, page };
}
async function visit(page, path, tag, shot) {
  const res = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45_000 });
  const status = res?.status() ?? 0;
  const info = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    h1: document.querySelector("h1")?.textContent?.trim() ?? "",
    error: /Application error|Internal Server Error|500/.test(document.title + (document.querySelector("h1")?.textContent ?? "")),
  }));
  check(`${tag} ${path} renders`, status > 0 && status < 400 && !info.error, `status ${status}, h1 "${info.h1.slice(0, 40)}"`);
  check(`${tag} ${path} no horizontal overflow`, info.overflow <= 1, `${info.overflow}px`);
  if (shot) await page.screenshot({ path: `${OUT}/${tag}-${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}.png`, fullPage: false });
}

for (const [viewport, tag] of [[{ width: 1440, height: 900 }, "desktop"], [{ width: 390, height: 844 }, "mobile"]]) {
  const { ctx, page } = await session(viewport, tag);
  await visit(page, "/login", tag, true);
  if (demo) {
    const accounts = [
      ["usr_gaon_admin", ["/dashboard", "/referrals", "/referrals/ir_2", "/cases", "/cases/case_3", "/cases/case_3?tab=ai", "/plans", "/service-referrals", "/providers", "/map", "/tasks", "/reports", "/audit", "/admin"]],
      ["usr_gaon_cm1", ["/dashboard", "/referrals/ir_2", "/cases/case_3?tab=ai"]],
      ["usr_gaon_pv1", ["/provider"]],
    ];
    for (const [user, paths] of tag === "desktop" ? accounts : accounts.slice(0, 1)) {
      await ctx.clearCookies();
      await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      await page.click(`[data-testid="demo-${user}"]`);
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
      check(`${tag} demo login ${user}`, true, page.url().replace(BASE, ""));
      for (const p of tag === "desktop" ? paths : ["/dashboard", "/referrals/ir_2", "/cases/case_3?tab=ai", "/providers", "/map"]) await visit(page, p, `${tag}-${user}`, tag === "mobile" || p.includes("ai") || p === "/dashboard");
      if (tag === "desktop" && user === "usr_gaon_admin") {
        // signed-in API reads through the browser context (same cookies), GET only
        for (const api of ["/api/dashboard", "/api/referrals", "/api/cases", "/api/providers", "/api/tasks", "/api/ai/drafts?caseId=case_3", "/api/ai/drafts?referralId=ir_2", "/api/admin/ai-metrics", "/api/admin/settings"]) {
          const r = await ctx.request.get(BASE + api);
          const body = await r.json().catch(() => null);
          check(`admin GET ${api} → 200 JSON`, r.status() === 200 && body !== null, `status ${r.status()}`);
          if (api === "/api/admin/settings") check("tenant AI switch is OFF (default)", body?.settings?.ai_enabled === false, `ai_enabled=${body?.settings?.ai_enabled}`);
          if (api === "/api/admin/ai-metrics") check("no AI jobs in production", body?.jobs?.requested === 0, JSON.stringify(body?.jobs));
        }
        const ai = page.locator('[data-testid^="ai-request-"]');
        await page.goto(`${BASE}/cases/case_3?tab=ai`, { waitUntil: "networkidle" });
        check("AI request button hidden while the tenant switch is off", (await ai.count()) === 0);
      }
      if (tag === "desktop" && user === "usr_gaon_cm1") {
        const r = await ctx.request.get(`${BASE}/api/admin/ai-metrics`);
        check("case manager cannot read admin AI metrics (403)", r.status() === 403, `status ${r.status()}`);
      }
    }
  }
  await ctx.close();
}
await browser.close();

check("no write request attempted by any page", report.blockedWrites.length === 0, report.blockedWrites.join(", "));
check("no browser console errors", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 5).join(" | "));
check("no uncaught page errors", report.pageErrors.length === 0, report.pageErrors.slice(0, 5).join(" | "));
report.finishedAt = new Date().toISOString();
report.failed = report.checks.filter((c) => !c.ok).length;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\n${report.checks.length - report.failed}/${report.checks.length} checks passed → ${OUT}/report.json`);
process.exit(report.failed ? 1 : 0);
