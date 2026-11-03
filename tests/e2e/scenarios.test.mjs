import { after, test } from "node:test";
import assert from "node:assert/strict";
import { BASE, closeBrowser, loginAs } from "./helpers.mjs";

after(closeBrowser);
const ADMIN = "usr_gaon_admin", CM = "usr_gaon_cm1", PV = "usr_gaon_pv2";

const ok = async (page, form) => {
  await form.locator('button[type="submit"]').click();
  await page.locator(".alert-ok:visible, .alert-error:visible").first().waitFor({ timeout: 15000 });
  const err = await page.locator(".alert-error:visible").count();
  if (err) throw new Error("form error: " + (await page.locator(".alert-error:visible").first().innerText()));
};

test("S1 admin: dashboard → referral inbox → detail → assign worker", async () => {
  const { ctx, page, errors } = await loginAs(ADMIN);
  await page.waitForURL("**/dashboard");
  assert.ok(await page.getByRole("heading", { name: "통합 현황" }).isVisible());
  await page.click('[data-testid="metric-hospital"]');
  await page.waitForURL("**/referrals");
  await page.getByRole("link", { name: "REF-2026-0001" }).click();
  await page.waitForURL("**/referrals/ir_1");
  assert.ok(await page.getByText("동의·법적 근거 확인 메타데이터").isVisible());
  assert.ok(await page.getByText("traceId").isVisible());
  const form = page.locator('[data-testid="assign-form"]');
  await form.locator("select").nth(0).selectOption("rg_haesol");
  await form.locator("select").nth(1).selectOption(CM);
  await ok(page, form);
  await page.reload();
  assert.ok(await page.locator(".page-head").getByText("확인 중").isVisible());
  assert.ok(await page.getByText("담당자 배정: 이하늘").isVisible());
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("S2 case manager: case → assessment → confirm → support plan → meeting → meeting result", async () => {
  const { ctx, page, errors } = await loginAs(CM);
  await page.goto(`${BASE}/cases/case_1?tab=assessment`);
  const domains = ["basic_profile", "household", "housing", "mobility_adl", "nutrition", "health_service_use", "ltc_care_needs", "social_relations", "family_burden", "recipient_wishes", "surveyor_opinion"];
  for (const d of domains) {
    await page.selectOption(`[data-testid="asm-status-${d}"]`, d === "social_relations" ? "no_response" : "confirmed");
    if (d !== "social_relations") await page.fill(`[data-testid="asm-value-${d}"]`, `E2E 조사 내용 ${d}`);
  }
  await page.click('[data-testid="asm-save"]');
  await page.getByText("조사 내용을 저장했습니다.").waitFor();
  await page.click('[data-testid="asm-submit"]');
  await page.getByText("검토 요청했습니다.").waitFor();
  await page.click('[data-testid="asm-confirm"]');
  await page.getByText("평가를 확정했습니다.").waitFor();
  await page.reload();
  assert.ok(await page.locator(".page-head").getByText("평가 확정").isVisible());

  await page.goto(`${BASE}/cases/case_1?tab=plan`);
  await page.fill('[data-testid="plan-goals"]', "퇴원 후 식사·이동 지원으로 재가 생활 유지");
  await page.fill('[data-testid="plan-mainNeeds"]', "식사 준비 어려움");
  await page.fill('[data-testid="plan-item-freq-0"]', "주 5회");
  await page.click('[data-testid="plan-save"]');
  await page.getByText("지원계획을 저장했습니다.").waitFor();
  await page.reload();
  await ok(page, page.locator('[data-testid="plan-to-REVIEW_REQUESTED"]'));
  await page.reload();
  await page.getByText("통합지원회의 등록").click();
  const mf = page.locator('[data-testid="meeting-create-form"]');
  await mf.locator('input[type="datetime-local"]').fill("2026-11-20T14:00");
  await mf.locator("textarea").first().fill("식사 지원 연계 검토");
  await ok(page, mf);
  await page.reload();
  await page.getByText("회의 결과 기록").click();
  const rf = page.locator('[data-testid="meeting-record-form"]');
  const ta = rf.locator("textarea");
  await ta.nth(0).fill("식사 준비가 어렵다는 점을 확인함");
  await ta.nth(2).fill("식사 지원 주 5회 연계 권고");
  await rf.locator("select").selectOption("approve_plan");
  await ta.nth(3).fill("지원계획 승인 권고");
  await ok(page, rf);
  await page.reload();
  assert.ok(await page.getByText("결과 기록됨").isVisible());
  assert.ok(await page.getByText("승인 권한이 없습니다").isVisible(), "case manager cannot approve");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("S3 approval → candidate comparison → service referral → provider accepts, schedules, starts", async () => {
  const a = await loginAs(ADMIN);
  await a.page.goto(`${BASE}/cases/case_1?tab=plan`);
  const af = a.page.locator('[data-testid="plan-approve-form"]');
  await af.locator("textarea").fill("통합지원회의 결정에 따라 승인");
  await ok(a.page, af);
  await a.ctx.close();

  const { ctx, page } = await loginAs(CM);
  await page.goto(`${BASE}/cases/case_1?tab=services`);
  const btn = page.locator('[data-testid^="match-"]').first();
  await btn.click();
  await page.locator('[data-testid="pick-pv_meal"]').waitFor();
  assert.ok(await page.getByText("대상자 주소 권역과 서비스 제공 권역이 일치함").first().isVisible());
  assert.ok(await page.getByText("판정하지 않습니다").isVisible());
  await page.check('[data-testid="pick-pv_meal"]');
  await page.locator('[data-testid^="sr-note-"]').fill("퇴원 후 주 5회 식사 배달 의뢰 (E2E)");
  await page.locator('[data-testid^="sr-create-"]').click();
  await page.getByText("의뢰 전송(제공기관 확인 중)").first().waitFor();
  await ctx.close();

  const p = await loginAs(PV);
  await p.page.waitForURL("**/provider");
  await p.page.getByRole("row").filter({ hasText: "C-0001" }).getByRole("link").click();
  await ok(p.page, p.page.locator('[data-testid="pv-ACCEPTED"]'));
  await p.page.reload();
  await p.page.getByText("일정 등록").first().click();
  const sf = p.page.locator('[data-testid="pv-SCHEDULED"]');
  await sf.locator('input[type="date"]').fill("2026-11-25");
  await ok(p.page, sf);
  await p.page.reload();
  await p.page.locator("summary", { hasText: "서비스 시작" }).click();
  await ok(p.page, p.page.locator('[data-testid="pv-STARTED"]'));
  await p.page.reload();
  assert.ok(await p.page.locator(".page-head").getByText("서비스 시작").isVisible());
  assert.ok(!(await p.page.content()).includes("합성대상자"), "provider never sees legal names");
  await p.ctx.close();
});

test("S4 monitoring → plan change flagged → service completed → plan review → case closed", async () => {
  const { ctx, page } = await loginAs(CM);
  await page.goto(`${BASE}/cases/case_1?tab=monitoring`);
  const mf = page.locator('[data-testid="monitoring-form"]');
  await mf.locator('select[name="method"]').selectOption("phone");
  await mf.locator('select[name="serviceUsed"]').selectOption("partial");
  await mf.locator('input[name="nonDeliveryReason"]').fill("배달 시간 불일치");
  await mf.locator('input[name="planChangeNeeded"]').check();
  await mf.locator('input[name="followUps"][value="service_change"]').check();
  await ok(page, mf);
  await page.goto(`${BASE}/cases/case_1`);
  assert.ok(await page.locator(".page-head").getByText("계획 재검토").isVisible());
  await ctx.close();

  const p = await loginAs(PV);
  await p.page.getByRole("row").filter({ hasText: "C-0001" }).getByRole("link").click();
  await p.page.locator("summary", { hasText: "수행 결과 제출" }).click();
  const cf = p.page.locator('[data-testid="pv-COMPLETED"]');
  await cf.locator("textarea").fill("계획된 기간 동안 식사 지원 제공 완료");
  await ok(p.page, cf);
  await p.ctx.close();

  const c = await loginAs(CM);
  await c.page.goto(`${BASE}/cases/case_1`);
  const sf = c.page.locator('[data-testid="case-status-form"]');
  await sf.locator("select").selectOption("CLOSED");
  await sf.locator('input[name="reason"]').fill("목표 달성 및 대상자 종결 동의");
  await ok(c.page, sf);
  await c.page.reload();
  assert.ok(await c.page.locator(".page-head").getByText("종결").isVisible());
  await c.ctx.close();
});

test("S5 access attempts outside scope are denied", async () => {
  const { ctx, page } = await loginAs(CM);
  for (const id of ["case_5", "case_nuri_1"]) {
    await page.goto(`${BASE}/cases/${id}`);
    assert.ok(await page.getByRole("heading", { name: "찾을 수 없습니다" }).isVisible(), id);
  }
  const api = await page.evaluate(async () => (await fetch("/api/cases/case_5")).status);
  assert.equal(api, 404);
  const post = await page.evaluate(async () => (await fetch("/api/cases/case_5/records", { method: "POST", headers: { "content-type": "application/json", "x-ngm-csrf": "1" }, body: JSON.stringify({ recordType: "note", body: "권한 밖 기록 시도", occurredAt: "2026-11-03T10:00" }) })).status);
  assert.equal(post, 404);
  await ctx.close();

  const p = await loginAs(PV);
  await p.page.goto(`${BASE}/provider/referrals/sr_2`);
  assert.ok(await p.page.getByRole("heading", { name: "찾을 수 없습니다" }).isVisible());
  await p.page.goto(`${BASE}/cases`);
  await p.page.waitForURL("**/forbidden");
  const s = await p.page.evaluate(async () => (await fetch("/api/cases/case_3")).status);
  assert.equal(s, 404);
  await p.ctx.close();

  const aud = await loginAs("usr_gaon_aud");
  await aud.page.waitForURL("**/audit");
  assert.ok(await aud.page.getByText("access.denied").first().isVisible(), "denials visible in audit log");
  await aud.ctx.close();
});
