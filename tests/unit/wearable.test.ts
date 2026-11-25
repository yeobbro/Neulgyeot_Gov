import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineFor, evaluateDay, fieldsOutsideConsent, noDataSignal, SIGNAL_RULES, type DailySummary } from "../../lib/domain/wearable";

const day = (offset: number, over: Partial<DailySummary> = {}): DailySummary => {
  const date = new Date(Date.UTC(2026, 10, 20) + offset * 86_400_000).toISOString().slice(0, 10);
  return { date, wearMinutes: 1300, steps: 2600, sleepMinutes: 420, restingHeartRate: 66, ...over };
};
const steadyHistory = Array.from({ length: 14 }, (_, i) => day(-14 + i, { steps: 2500 + (i % 3) * 100 }));

test("baseline uses only earlier, well-worn days within the window", () => {
  const history = [...steadyHistory.filter((h) => h.date !== day(-3).date), day(-20, { steps: 99_999 }), day(-3, { wearMinutes: 100, steps: 1 }), day(0, { steps: 1 })];
  const b = baselineFor(history, day(0).date);
  assert.equal(b.days, 13); // -20 is outside the window, -3 was barely worn, day 0 is the day itself
  assert.equal(b.steps, 2600);
});

test("steady day → no signals", () => {
  assert.deepEqual(evaluateDay(day(0), steadyHistory), []);
});

test("activity drop, sleep change and resting HR change carry their basis", () => {
  const s = evaluateDay(day(0, { steps: 800, sleepMinutes: 600, restingHeartRate: 84 }), steadyHistory);
  const types = s.map((x) => x.type).sort();
  assert.deepEqual(types, ["activity_drop", "resting_hr_change", "sleep_change"]);
  const a = s.find((x) => x.type === "activity_drop")!;
  assert.equal(a.basis.value, 800);
  assert.equal(a.basis.baseline, 2600);
  assert.match(a.message, /평소/);
});

test("too few baseline days → no comparison signals (missing data is not 'normal' nor an alarm)", () => {
  const short = steadyHistory.slice(-SIGNAL_RULES.baselineMinDays + 1);
  assert.deepEqual(evaluateDay(day(0, { steps: 100, sleepMinutes: 900 }), short), []);
});

test("low wear suppresses comparison signals but device-reported events still surface", () => {
  const s = evaluateDay(day(0, { wearMinutes: 120, steps: 10, fallEvents: 1 }), steadyHistory);
  assert.deepEqual(s.map((x) => x.type).sort(), ["fall_reported", "low_wear"]);
  assert.ok(s.every((x) => !/진단|응급/.test(x.message)), "no diagnostic or emergency wording");
});

test("SOS and low SpO2 reports", () => {
  const s = evaluateDay(day(0, { sosEvents: 2, spo2Min: 87 }), steadyHistory);
  assert.deepEqual(s.map((x) => x.type).sort(), ["sos_reported", "spo2_low_reported"]);
  assert.match(s.find((x) => x.type === "spo2_low_reported")!.message, /측정 오류/);
});

test("fields outside the consented categories are detected", () => {
  assert.deepEqual(fieldsOutsideConsent(day(0, { spo2Min: 95 }), ["wear", "activity", "sleep", "heart_rate"]), ["spo2Min"]);
  assert.deepEqual(fieldsOutsideConsent(day(0, { restingHeartRate: null }), ["wear", "activity", "sleep"]), []);
});

test("no_data after 48h, counted from pairing when nothing ever arrived", () => {
  const now = new Date("2026-11-25T09:00:00Z");
  assert.equal(noDataSignal(new Date("2026-11-24T09:00:00Z"), new Date("2026-11-01T00:00:00Z"), now), null);
  const s = noDataSignal(new Date("2026-11-22T08:00:00Z"), new Date("2026-11-01T00:00:00Z"), now)!;
  assert.equal(s.type, "no_data");
  assert.equal(s.basis.hours, 73);
  assert.ok(noDataSignal(null, new Date("2026-11-20T00:00:00Z"), now));
});
