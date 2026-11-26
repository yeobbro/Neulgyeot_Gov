import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_PROFILES, defaultProfileFor, profileOf, unsupportedMetrics } from "../../lib/domain/devices";
import { evaluateDay, type DailySummary } from "../../lib/domain/wearable";

test("SIGRING100 profile reflects the public spec: no location / fall / SOS, daily phone sync, not a medical device", () => {
  const p = DEVICE_PROFILES.sigring100;
  assert.equal(p.location, false);
  assert.equal(p.realtimeReadings, false);
  assert.equal(p.medicalDevice, false);
  assert.deepEqual(unsupportedMetrics("sigring100", ["wear", "vitality", "fall", "sos", "temperature"]), ["fall", "sos", "temperature"]);
  assert.deepEqual(p.unconfirmed, ["spo2"]);
  assert.equal(profileOf("unknown").id, "generic_ring");
  assert.equal(defaultProfileFor("smart_watch"), "generic_watch");
});

const steady = (n: number): DailySummary[] => Array.from({ length: n }, (_, i) => ({
  date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10), wearMinutes: 1300, steps: 3000, sleepMinutes: 420,
  hrvRmssd: 30 + (i % 3), vitalityScore: 82 + (i % 3), skinTempDeviationC: 0.1,
}));

test("ring metrics: vitality drop, HRV drop and skin-temperature rise are compared with the person's own usual", () => {
  const hist = steady(10);
  const day = { date: "2026-11-11", wearMinutes: 1300, steps: 2900, sleepMinutes: 430, hrvRmssd: 18, vitalityScore: 68, skinTempDeviationC: 1.2 };
  const types = evaluateDay(day, [...hist, day]).map((s) => s.type).sort();
  assert.deepEqual(types, ["hrv_drop", "skin_temp_rise", "vitality_drop"]);
  const msg = evaluateDay(day, [...hist, day]).find((s) => s.type === "skin_temp_rise")!.message;
  assert.match(msg, /체온 아님/);
  // a small dip is not a signal; without enough history there is no comparison
  assert.deepEqual(evaluateDay({ ...day, hrvRmssd: 27, vitalityScore: 78, skinTempDeviationC: 0.4 }, [...hist, day]), []);
  assert.deepEqual(evaluateDay({ ...day, skinTempDeviationC: 0 }, [day]).map((s) => s.type), []);
});
