import { chromium } from "playwright";
export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
let browser;
export async function getBrowser() {
  browser ??= await chromium.launch();
  return browser;
}
export async function closeBrowser() {
  await browser?.close();
  browser = undefined;
}
export async function loginAs(userId, viewport = { width: 1440, height: 900 }) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`);
  await page.click(`[data-testid="demo-${userId}"]`);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  return { ctx, page, errors };
}
export async function submitAndWait(page, formLocator) {
  await formLocator.locator('button[type="submit"]').click();
  await page.waitForLoadState("networkidle");
}
