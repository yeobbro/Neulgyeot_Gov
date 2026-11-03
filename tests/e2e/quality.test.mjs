import { after, test } from "node:test";
import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
import { BASE, closeBrowser, getBrowser, loginAs } from "./helpers.mjs";

after(closeBrowser);
const PAGES = ["/dashboard", "/referrals", "/referrals/ir_2", "/cases", "/cases/case_3", "/cases/case_4?tab=plan", "/cases/case_9?tab=assessment", "/cases/case_3?tab=services", "/providers", "/map", "/reports", "/tasks", "/admin", "/audit"];

test("axe: no serious or critical accessibility violations", async () => {
  const b = await getBrowser();
  const actx = await b.newContext();
  const anon = await actx.newPage();
  await anon.goto(`${BASE}/login`);
  const lr = await new AxeBuilder({ page: anon }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = lr.violations.filter((v) => ["serious", "critical"].includes(v.impact));
  assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.length}`), [], "login");
  await actx.close();
  const { ctx, page } = await loginAs("usr_gaon_admin");
  const report = [];
  for (const u of PAGES) {
    await page.goto(BASE + u);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    for (const v of r.violations.filter((v) => ["serious", "critical"].includes(v.impact))) report.push(`${u} ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
  }
  assert.deepEqual(report, []);
  await ctx.close();
});

test("keyboard: skip link and visible focus", async () => {
  const { ctx, page } = await loginAs("usr_gaon_admin");
  await page.goto(`${BASE}/dashboard`);
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.textContent);
  assert.equal(first, "본문 바로가기");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.notEqual(outline, "none");
  const landmarks = await page.evaluate(() => ({ main: !!document.querySelector("main"), nav: !!document.querySelector("nav[aria-label='주 메뉴']"), header: !!document.querySelector("header") }));
  assert.deepEqual(landmarks, { main: true, nav: true, header: true });
  await ctx.close();
});

for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`responsive ${vp.width}px: no horizontal page overflow`, async () => {
    const { ctx, page } = await loginAs("usr_gaon_admin", vp);
    const overflow = [];
    for (const u of PAGES) {
      await page.goto(BASE + u);
      const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      if (w.s > w.c + 1) overflow.push(`${u}: ${w.s} > ${w.c}`);
    }
    assert.deepEqual(overflow, []);
    await page.goto(`${BASE}/cases`);
    await page.screenshot({ path: `test-results/cases-${vp.width}.png`, fullPage: false });
    await ctx.close();
  });
}
