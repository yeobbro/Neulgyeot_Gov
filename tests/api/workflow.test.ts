import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../lib/server/db/client";
import * as assign from "../../app/api/referrals/[id]/assign/route";
import * as accept from "../../app/api/referrals/[id]/accept/route";
import * as consentReview from "../../app/api/referrals/[id]/consent-review/route";
import * as assessment from "../../app/api/cases/[id]/assessment/route";
import * as submit from "../../app/api/cases/[id]/assessment/[aid]/submit/route";
import * as confirm from "../../app/api/cases/[id]/assessment/[aid]/confirm/route";
import * as plan from "../../app/api/cases/[id]/plan/route";
import * as planTransition from "../../app/api/cases/[id]/plan/[planId]/transition/route";
import * as meetings from "../../app/api/cases/[id]/meetings/route";
import * as meetingRecord from "../../app/api/cases/[id]/meetings/[mid]/record/route";
import * as match from "../../app/api/cases/[id]/match/route";
import * as sref from "../../app/api/cases/[id]/service-referrals/route";
import * as srTransition from "../../app/api/service-referrals/[id]/transition/route";
import * as monitoring from "../../app/api/cases/[id]/monitoring/route";
import * as caseRoute from "../../app/api/cases/[id]/route";
import * as caseStatus from "../../app/api/cases/[id]/status/route";
import * as drafts from "../../app/api/ai/drafts/route";
import * as review from "../../app/api/ai/drafts/[id]/review/route";
import * as dashboardRoute from "../../app/api/dashboard/route";
import * as reports from "../../app/api/reports/route";
import { ASSESSMENT_DOMAINS } from "../../lib/domain/enums";
import { call, freshDb, DEMO_USERS } from "../helpers";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

const A = DEMO_USERS.admin, CM = DEMO_USERS.cmHaesol, PV = DEMO_USERS.providerMeal;

test("end-to-end municipal workflow: referral → case → assessment → plan → meeting → referral → delivery → monitoring", async () => {
  // 1. referral with a pending legal-basis category cannot be accepted until reviewed
  assert.equal((await call(assign.POST, { as: A, params: { id: "ir_5" }, body: { userId: CM, regionUnitId: "rg_haesol" } })).status, 200);
  await db.query(`UPDATE consent_evidence SET decision = 'pending_review' WHERE referral_id = 'ir_5' AND category = 'kAdl'`);
  const blocked = await call(accept.POST, { as: CM, params: { id: "ir_5" }, body: { displayName: "가명 신규" } });
  assert.equal(blocked.status, 400);
  assert.equal((await call(consentReview.POST, { as: A, params: { id: "ir_5" }, body: { category: "kAdl", legalBasisNote: "개인정보 보호법 제23조 별도 동의서 확인 (DEMO)" } })).status, 200);
  const acc = await call(accept.POST, { as: CM, params: { id: "ir_5" }, body: { displayName: "가명 신규", ageBand: "80대" } });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  const caseId = acc.json.caseId as string;
  const [ident] = await db.query<any>(`SELECT i.legal_name FROM recipient_identities i JOIN care_cases c ON c.recipient_id = i.recipient_id WHERE c.id = $1`, [caseId]);
  assert.ok(ident, "identity stored separately");

  // 2. assessment: incomplete cannot be submitted; complete → submit → confirm
  const items = ASSESSMENT_DOMAINS.map((d, i) => ({ domain: d, answerStatus: i === 7 ? "no_response" : "confirmed", value: i === 7 ? "" : `조사 내용 ${i}`, note: "" }));
  const s1 = await call(assessment.PUT, { method: "PUT", as: CM, params: { id: caseId }, body: { items: items.slice(0, 3), home: { housingType: "단독주택", barriers: ["계단"], heatingCooling: null, safetyNotes: "", modificationNeeded: true } } });
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  const aid = s1.json.assessmentId;
  assert.equal((await call(submit.POST, { as: CM, params: { id: caseId, aid } })).status, 400, "missing domains block submission");
  assert.equal((await call(assessment.PUT, { method: "PUT", as: CM, params: { id: caseId }, body: { assessmentId: aid, items } })).status, 200);
  assert.equal((await call(submit.POST, { as: CM, params: { id: caseId, aid } })).status, 200);
  assert.equal((await call(confirm.POST, { as: CM, params: { id: caseId, aid } })).status, 200);
  assert.equal((await call(caseRoute.GET, { as: CM, params: { id: caseId } })).json.case.status, "ASSESSMENT_COMPLETED");

  // 3. plan → review request → meeting → record decision → approval (admin only)
  const p = await call(plan.PUT, { method: "PUT", as: CM, params: { id: caseId }, body: { goals: "퇴원 후 재가 생활 유지", mainNeeds: "식사 준비", recipientWishes: "집에서 생활", items: [{ serviceType: "meal", department: "복지정책과", frequency: "주 5회", method: "배달" }] } });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const planId = p.json.planId;
  assert.equal((await call(planTransition.POST, { as: CM, params: { id: caseId, planId }, body: { to: "APPROVED", approvalBasis: "바로 승인" } })).status, 409, "no one-click approval from DRAFT");
  assert.equal((await call(planTransition.POST, { as: CM, params: { id: caseId, planId }, body: { to: "REVIEW_REQUESTED" } })).status, 200);
  const m = await call(meetings.POST, { as: CM, params: { id: caseId }, body: { planId, scheduledAt: "2026-11-10T14:00", agenda: "식사 지원 연계 검토", participants: [{ organization: "통합돌봄과", role: "주관" }] } });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  const rec = await call(meetingRecord.POST, { as: CM, params: { id: caseId, mid: m.json.meetingId }, body: { confirmedFacts: "식사 준비 어려움 확인", openQuestions: "", outcome: "식사 지원 연계 결정", decision: "approve_plan", decisionContent: "식사 지원 주 5회 승인 권고" } });
  assert.equal(rec.status, 200, JSON.stringify(rec.json));
  assert.equal((await call(planTransition.POST, { as: CM, params: { id: caseId, planId }, body: { to: "APPROVED", approvalBasis: "회의 결정" } })).status, 403);
  const ap = await call(planTransition.POST, { as: A, params: { id: caseId, planId }, body: { to: "APPROVED", approvalBasis: "통합지원회의 결정에 따름" } });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));

  // 4. matching → service referral → provider accept/schedule/start
  const planNow = await call(plan.GET, { as: CM, params: { id: caseId } });
  const itemId = planNow.json.items[0].id;
  const mm = await call(match.GET, { as: CM, params: { id: caseId }, url: `/api/cases/${caseId}/match?planItemId=${itemId}` });
  assert.equal(mm.status, 200);
  assert.ok(mm.json.candidates.some((c: any) => c.providerId === "pv_meal"));
  assert.ok(mm.json.candidates.every((c: any) => c.reasons.length > 0));
  const sr = await call(sref.POST, { as: CM, params: { id: caseId }, body: { planItemId: itemId, providerId: "pv_meal", requestNote: "주 5회 식사 배달 의뢰" } });
  assert.equal(sr.status, 200, JSON.stringify(sr.json));
  assert.equal((await call(sref.POST, { as: CM, params: { id: caseId }, body: { planItemId: itemId, providerId: "pv_meal2", requestNote: "중복 의뢰 시도" } })).status, 409);
  const srId = sr.json.id;
  assert.equal((await call(srTransition.POST, { as: PV, params: { id: srId }, body: { to: "ACCEPTED", note: "수락" } })).status, 200);
  assert.equal((await call(srTransition.POST, { as: PV, params: { id: srId }, body: { to: "SCHEDULED" } })).status, 400, "start date required");
  assert.equal((await call(srTransition.POST, { as: PV, params: { id: srId }, body: { to: "SCHEDULED", scheduledStart: "2026-11-12" } })).status, 200);
  assert.equal((await call(srTransition.POST, { as: PV, params: { id: srId }, body: { to: "STARTED", note: "첫 배달 완료" } })).status, 200);
  assert.equal((await call(caseRoute.GET, { as: CM, params: { id: caseId } })).json.case.status, "SERVICE_ACTIVE");

  // 5. monitoring flags a plan change → PLAN_REVIEW; closing is blocked while services run
  const mon = await call(monitoring.POST, { as: CM, params: { id: caseId }, body: { checkedAt: "2026-11-20T10:00", method: "phone", serviceUsed: "partial", satisfaction: "neutral", nonDeliveryReason: "배달 시간 불일치", planChangeNeeded: true, followUps: ["service_change"] } });
  assert.equal(mon.status, 200, JSON.stringify(mon.json));
  assert.equal((await call(caseRoute.GET, { as: CM, params: { id: caseId } })).json.case.status, "PLAN_REVIEW");
  const close = await call(caseStatus.POST, { as: CM, params: { id: caseId }, body: { to: "CLOSED", reason: "목표 달성" } });
  assert.equal(close.status, 409);

  // 6. audit trail covers the key events, without personal text
  const actions = (await db.query<{ action: string }>(`SELECT DISTINCT action FROM audit_logs`)).map((a) => a.action);
  for (const a of ["referral.assign", "referral.consent_review", "assessment.confirm", "plan.approve", "meeting.record", "service_referral.create", "service_referral.status_change", "monitoring.create", "case.view"]) assert.ok(actions.includes(a), a);
  const meta = await db.query<{ m: string }>(`SELECT meta::text AS m FROM audit_logs`);
  assert.ok(meta.every((x) => !x.m.includes("배달 시간 불일치") && !x.m.includes("가명 신규")));
});

test("AI drafts: rule-based, every sentence cites sources, stored as draft until a human approves", async () => {
  const g = await call(drafts.POST, { as: CM, body: { kind: "social_opinion", caseId: "case_3" } });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.engine, "rules");
  const ids = new Set(g.json.facts.map((f: any) => f.id));
  for (const s of g.json.sections) for (const sen of s.sentences) assert.ok(sen.factIds.every((f: string) => ids.has(f)));
  assert.equal(g.json.sections.length, 6);
  const [d] = await db.query<any>(`SELECT status FROM ai_drafts WHERE id = $1`, [g.json.id]);
  assert.equal(d.status, "draft");
  const refs = await db.query<any>(`SELECT count(*)::int AS n FROM ai_source_references WHERE draft_id = $1`, [g.json.id]);
  assert.ok(refs[0].n > 0);
  const r1 = await call(drafts.POST, { as: A, body: { kind: "referral_summary", referralId: "ir_2" } });
  assert.equal(r1.status, 200);
  assert.ok(r1.json.text.includes("보완 요청"));
  const mb = await call(drafts.POST, { as: CM, body: { kind: "meeting_brief", caseId: "case_3" } });
  assert.equal(mb.status, 200);
  const ok = await call(review.POST, { as: CM, params: { id: g.json.id }, body: { action: "approve", editedText: "담당자가 검토·수정한 소견서 본문입니다.", saveAsRecord: true } });
  assert.equal(ok.status, 200);
  assert.equal((await call(review.POST, { as: CM, params: { id: g.json.id }, body: { action: "approve" } })).status, 409);
  const rec = await db.query<any>(`SELECT body FROM case_records WHERE case_id = 'case_3' AND body LIKE '[검토 승인된%'`);
  assert.equal(rec.length, 1);
  // other-region worker cannot generate for a case outside scope
  assert.equal((await call(drafts.POST, { as: DEMO_USERS.cmMaru, body: { kind: "social_opinion", caseId: "case_3" } })).status, 404);
});

test("dashboard metrics and reports come from real aggregates with definitions", async () => {
  const d = await call(dashboardRoute.GET, { as: A });
  assert.equal(d.status, 200);
  const total = d.json.metrics.find((m: any) => m.key === "total");
  const [{ n }] = await db.query<any>(`SELECT count(*)::int AS n FROM care_cases WHERE tenant_id = 'tn_gaon' AND status NOT IN ('CLOSED','WITHDRAWN')`);
  assert.equal(total.value, n);
  assert.ok(d.json.metrics.every((m: any) => m.href && m.definition));
  const cm = await call(dashboardRoute.GET, { as: DEMO_USERS.cmMaru });
  assert.ok(cm.json.regions.every((r: any) => ["마루동", "새봄동"].includes(r.region)));
  const rep = await call(reports.GET, { as: A, url: "/api/reports?from=2026-01-01&to=2026-12-31" });
  assert.equal(rep.status, 200);
  assert.ok(rep.json.sections.every((s: any) => s.definition && s.formula));
  assert.ok(rep.json.dataQuality.length >= 2);
});
