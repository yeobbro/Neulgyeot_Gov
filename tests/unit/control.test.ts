import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySubject, evaluateReading, resolveLocation, serviceGroupOf, PROVISIONAL_VITAL_THRESHOLDS } from "../../lib/domain/control";

const now = new Date("2026-11-26T09:00:00Z");
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();

test("thresholds are explicitly marked as not clinically reviewed", () => {
  assert.equal(PROVISIONAL_VITAL_THRESHOLDS.reviewed, false);
});

test("evaluateReading: urgent beats caution, parts carry the basis, missing values are not 'normal'", () => {
  const u = evaluateReading({ measuredAt: at(1), heartRate: 128, bodyTempC: 38.6, spo2: 91 });
  assert.equal(u.vital?.kind, "vital_urgent");
  assert.deepEqual(u.vital?.parts, ["심박 128bpm", "체온 38.6℃", "SpO₂ 91%"], "caution-range values are listed after the urgent ones");
  assert.equal(evaluateReading({ measuredAt: at(1), heartRate: 102 }).vital?.kind, "vital_caution");
  assert.equal(evaluateReading({ measuredAt: at(1), spo2: 89 }).vital?.kind, "vital_urgent");
  assert.equal(evaluateReading({ measuredAt: at(1), heartRate: 72, bodyTempC: 36.5, spo2: 97 }).vital, null);
  assert.equal(evaluateReading({ measuredAt: at(1), event: "sos" }).vital, null);
  assert.deepEqual(evaluateReading({ measuredAt: at(1), event: "sos" }).events, ["sos"]);
});

test("classifySubject: one exclusive status with urgent > caution > in_service > normal > unlinked", () => {
  const base = { hasDevice: true, readingFresh: true, openUrgentAlerts: 0, openCautionAlerts: 0, openWearableSignals: 0, visitInProgress: false };
  assert.equal(classifySubject({ ...base, openUrgentAlerts: 1, visitInProgress: true }), "urgent");
  assert.equal(classifySubject({ ...base, openWearableSignals: 2 }), "caution");
  assert.equal(classifySubject({ ...base, readingFresh: false }), "caution", "a device that stopped reporting needs a look");
  assert.equal(classifySubject({ ...base, visitInProgress: true }), "in_service");
  assert.equal(classifySubject(base), "normal");
  assert.equal(classifySubject({ ...base, hasDevice: false, readingFresh: false }), "unlinked");
});

test("resolveLocation: current only with consent AND a fresh fix; otherwise the designated location with the reason", () => {
  const fix = { lat: 37.5, lng: 127.05, accuracyM: 20, at: at(5) };
  const designated = { lat: 37.49, lng: 127.04, label: "거주지 근사" };
  assert.equal(resolveLocation({ consentActive: true, fix, designated }, now).mode, "current");
  const noConsent = resolveLocation({ consentActive: false, fix, designated }, now);
  assert.deepEqual([noConsent.mode, noConsent.mode === "designated" && noConsent.reason], ["designated", "no_consent"]);
  const stale = resolveLocation({ consentActive: true, fix: { ...fix, at: at(90) }, designated }, now);
  assert.deepEqual([stale.mode, stale.mode === "designated" && stale.reason], ["designated", "stale"]);
  assert.equal(resolveLocation({ consentActive: false, fix: null, designated: null }, now).mode, "none");
});

test("service groups map existing catalogue codes", () => {
  assert.equal(serviceGroupOf("home_care"), "care");
  assert.equal(serviceGroupOf("visiting_nursing"), "nursing");
  assert.equal(serviceGroupOf("meal"), "meal");
  assert.equal(serviceGroupOf("ltc_link"), "other");
});
