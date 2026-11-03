import { test } from "node:test";
import assert from "node:assert/strict";
import { CASE_TRANSITIONS, PLAN_TRANSITIONS, REFERRAL_TRANSITIONS, SERVICE_REFERRAL_TRANSITIONS, canTransition } from "../../lib/domain/enums";
import { capacityFreshness, matchProviders, type MatchProvider } from "../../lib/domain/matching";
import { csvCell, toCsv } from "../../lib/domain/csv";
import { validateAssessmentForConfirm, canConfirmAssessment, answerSummary } from "../../lib/domain/assessment";
import { verifyDraft, FORBIDDEN_PATTERNS } from "../../lib/domain/ai-draft";
import { evaluateConsent, minimizePayload } from "../../lib/integrations/hospital/consent-scope";
import { referralEnvelopeSchema } from "../../lib/integrations/hospital/schema";
import { sanitizeMeta } from "../../lib/server/audit";
import { suppress } from "../../lib/domain/metrics";
import { envelope } from "../helpers";

test("workflow transitions are enforced by the state machines", () => {
  assert.ok(canTransition(REFERRAL_TRANSITIONS, "RECEIVED", "UNDER_REVIEW"));
  assert.ok(!canTransition(REFERRAL_TRANSITIONS, "RECEIVED", "ACCEPTED_FOR_ASSESSMENT"));
  assert.ok(canTransition(REFERRAL_TRANSITIONS, "NEEDS_INFORMATION", "RESUBMITTED"));
  assert.ok(!canTransition(REFERRAL_TRANSITIONS, "CLOSED", "UNDER_REVIEW"));
  assert.ok(canTransition(CASE_TRANSITIONS, "SURVEY_IN_PROGRESS", "ASSESSMENT_REVIEW"));
  assert.ok(!canTransition(CASE_TRANSITIONS, "APPLICATION_RECEIVED", "SERVICE_ACTIVE"));
  assert.ok(!canTransition(CASE_TRANSITIONS, "CLOSED", "SERVICE_ACTIVE"));
  for (const s of Object.keys(CASE_TRANSITIONS)) if (!["CLOSED", "WITHDRAWN"].includes(s)) assert.ok(canTransition(CASE_TRANSITIONS, s as never, "WITHDRAWN"), s);
  assert.ok(!canTransition(PLAN_TRANSITIONS, "DRAFT", "APPROVED"), "no one-click approval from draft");
  assert.ok(canTransition(PLAN_TRANSITIONS, "MEETING_SCHEDULED", "APPROVED"));
  assert.ok(canTransition(SERVICE_REFERRAL_TRANSITIONS, "REQUESTED", "UNAVAILABLE"));
  assert.ok(!canTransition(SERVICE_REFERRAL_TRANSITIONS, "REQUESTED", "STARTED"));
  assert.ok(!canTransition(SERVICE_REFERRAL_TRANSITIONS, "CANCELED", "REQUESTED"));
});

const now = new Date("2026-11-03T00:00:00Z");
const prov = (id: string, over: Partial<MatchProvider> = {}): MatchProvider => ({
  id, name: id, isActive: true, visitDays: ["mon"], isSynthetic: true,
  serviceAreas: [{ regionUnitId: "r1", serviceType: "meal" }],
  capacity: { meal: { status: "available", confirmedAt: "2026-11-01T00:00:00Z" } }, ...over,
});

test("provider matching is explainable and never excludes on stale capacity", () => {
  const r = matchProviders({ serviceType: "meal", regionUnitIds: ["r1"], preferredDays: ["mon"] }, [
    prov("a"),
    prov("b", { serviceAreas: [{ regionUnitId: "r2", serviceType: "meal" }] }),
    prov("c", { serviceAreas: [{ regionUnitId: "r1", serviceType: "mobility" }] }),
    prov("d", { isActive: false }),
    prov("e", { capacity: { meal: { status: "available", confirmedAt: "2026-09-01T00:00:00Z" } } }),
  ], now);
  assert.deepEqual(r.candidates.map((c) => c.providerId), ["a", "e"]);
  assert.ok(r.candidates[0].reasons.includes("대상자 주소 권역과 서비스 제공 권역이 일치함"));
  assert.ok(r.candidates[0].reasons.some((x) => x.includes("최근 수용 가능")));
  assert.ok(r.candidates[1].cautions.some((x) => x.includes("확인 필요")));
  assert.equal(r.excluded.length, 3);
  assert.match(r.notice, /판정하지 않습니다/);
});

test("capacity freshness turns old confirmations into 확인 필요", () => {
  assert.equal(capacityFreshness(null, now).status, "unknown");
  assert.equal(capacityFreshness({ status: "available", confirmedAt: "2026-10-30T00:00:00Z" }, now).status, "available");
  const stale = capacityFreshness({ status: "available", confirmedAt: "2026-10-01T00:00:00Z" }, now);
  assert.equal(stale.status, "unknown");
  assert.ok(stale.stale);
  assert.match(stale.label, /확인 필요/);
});

test("CSV export neutralises formula injection", () => {
  for (const bad of ["=HYPERLINK(\"x\")", "+1", "-2+3", "@SUM(A1)", "\tcmd"]) assert.ok(csvCell(bad).replace(/^"/, "").startsWith("'"), bad);
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.ok(toCsv(["h"], [["=1"]]).includes("'=1"));
});

test("assessment: no-response is never silently normal; official determination needs ABAC flag", () => {
  const issues = validateAssessmentForConfirm([{ domain: "housing", answerStatus: "confirmed", value: "", note: "" }]);
  assert.ok(issues.some((i) => i.path === "housing"));
  assert.ok(issues.some((i) => i.path === "nutrition"), "missing domains flagged");
  assert.equal(answerSummary([{ answerStatus: "no_response" }]).no_response, 1);
  assert.ok(!canConfirmAssessment("official_determination", { canConfirmOfficialDetermination: false, isAdmin: true, isAssigned: true }));
  assert.ok(canConfirmAssessment("official_determination", { canConfirmOfficialDetermination: true, isAdmin: false, isAssigned: false }));
  assert.ok(canConfirmAssessment("municipal_survey", { canConfirmOfficialDetermination: false, isAdmin: false, isAssigned: true }));
  assert.ok(!canConfirmAssessment("municipal_survey", { canConfirmOfficialDetermination: false, isAdmin: false, isAssigned: false }));
});

test("AI draft verification requires real source references and blocks judgments", () => {
  const facts = [{ id: "F1", text: "x", sourceType: "t", sourceId: "s", field: "f" }];
  assert.ok(verifyDraft({ sections: [{ title: "a", sentences: [{ text: "사실 요약입니다.", factIds: ["F1"] }] }] }, facts).ok);
  assert.ok(!verifyDraft({ sections: [{ title: "a", sentences: [{ text: "근거 없음", factIds: ["F9"] }] }] }, facts).ok);
  assert.ok(!verifyDraft({ sections: [{ title: "a", sentences: [{ text: "서비스 수급 대상으로 판단됨", factIds: ["F1"] }] }] }, facts).ok);
  assert.ok(!verifyDraft({ sections: [{ title: "a", sentences: [{ text: "긴급한 개입 필요", factIds: ["F1"] }] }] }, facts).ok);
  assert.ok(FORBIDDEN_PATTERNS.length > 5);
});

test("consent scope: per-category decisions, policy blocking and minimisation", () => {
  const ok = referralEnvelopeSchema.parse(envelope());
  const ev = evaluateConsent(ok);
  assert.ok(ev.ok);
  assert.ok(ev.decisions.every((d) => d.decision === "accepted"));

  const outOfScope = referralEnvelopeSchema.parse(envelope({ consent: { ...envelope().consent, scope: ["identity", "discharge", "livingNeeds"] } }));
  assert.ok(!evaluateConsent(outOfScope).ok, "kAdl present but not consented");

  const noSensitive = referralEnvelopeSchema.parse(envelope({ consent: { ...envelope().consent, sensitiveInformationConsent: "notGranted" } }));
  assert.ok(!evaluateConsent(noSensitive).ok);

  const withDx = referralEnvelopeSchema.parse(envelope({
    clinicalSummary: { ...envelope().clinicalSummary, principalDiagnosis: { system: "KCD", code: "I63", display: "x" }, medicationSummary: [{ name: "m", frequency: "1" }] },
    consent: { ...envelope().consent, scope: ["identity", "discharge", "kAdl", "cognition", "livingNeeds", "principalDiagnosis", "medicationSummary"] },
  }));
  const ev2 = evaluateConsent(withDx);
  assert.ok(ev2.ok);
  assert.equal(ev2.decisions.find((d) => d.category === "principalDiagnosis")?.decision, "blocked_by_policy");
  const stored = minimizePayload(withDx, ev2);
  assert.equal((stored.functionalSummary as any).principalDiagnosis, undefined);
  assert.equal((stored.functionalSummary as any).medicationSummary, undefined);
  assert.equal(JSON.stringify(stored).includes("SYN-P-0101"), false, "hospital patient id not stored");

  const noBasis = referralEnvelopeSchema.parse(envelope({ consent: { ...envelope().consent, legalBasis: undefined } }));
  assert.equal(evaluateConsent(noBasis).decisions.find((d) => d.category === "kAdl")?.decision, "pending_review");
});

test("schema rejects unknown fields and contact data", () => {
  assert.ok(!referralEnvelopeSchema.safeParse(envelope({ subject: { patientId: "x", name: "y", birthDate: "1940-01-01", contact: "010-0000-0000" } })).success);
  assert.ok(!referralEnvelopeSchema.safeParse({ ...envelope(), nursingNotes: "full EMR" }).success);
  assert.ok(!referralEnvelopeSchema.safeParse(envelope({ schemaVersion: "9.9" })).success);
});

test("audit meta never keeps personal-looking keys; small cells suppressed", () => {
  assert.deepEqual(sanitizeMeta({ name: "x", birthDate: "y", note: "z", status: "ok" }), { status: "ok" });
  assert.equal(suppress(2, true), "<3");
  assert.equal(suppress(0, true), "0");
  assert.equal(suppress(5, true), "5");
});
