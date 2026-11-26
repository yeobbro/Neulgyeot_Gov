/**
 * Wearable (smart ring / smart watch) daily summaries → explainable "확인 필요" signals.
 *
 * Not a medical device and not an emergency path: no diagnosis, no emergency determination. Signals compare a day
 * with the recipient's own recent baseline and always carry their basis. Missing data is reported as missing,
 * never as "normal". See docs/WEARABLE_INTEGRATION.md.
 */

export const DEVICE_KINDS = ["smart_ring", "smart_watch"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = { smart_ring: "스마트링", smart_watch: "스마트워치" };

/** Consent categories. `wear` is required: without it no other metric can be interpreted. */
export const WEARABLE_METRICS = ["wear", "activity", "sleep", "heart_rate", "spo2", "temperature", "fall", "sos", "hrv", "skin_temp", "stress", "vitality"] as const;
export type WearableMetric = (typeof WEARABLE_METRICS)[number];
export const WEARABLE_METRIC_LABEL: Record<WearableMetric, string> = {
  wear: "착용 시간",
  activity: "활동량(걸음·활동 시간)",
  sleep: "수면 시간",
  heart_rate: "심박(안정 시·최저·최고)",
  spo2: "산소포화도(최저)",
  temperature: "체온(기기 측정값, 참고용)",
  hrv: "심박변이도(HRV)",
  skin_temp: "피부 온도 변화(평소 대비)",
  stress: "스트레스 지수(기기 산출)",
  vitality: "종합 활력 지수(기기 산출)",
  fall: "낙상 감지 기록",
  sos: "SOS 버튼 기록",
};

/** Contract field → consent category. */
export const FIELD_METRIC = {
  wearMinutes: "wear",
  steps: "activity",
  activeMinutes: "activity",
  sleepMinutes: "sleep",
  restingHeartRate: "heart_rate",
  heartRateMin: "heart_rate",
  heartRateMax: "heart_rate",
  spo2Min: "spo2",
  fallEvents: "fall",
  sosEvents: "sos",
  sleepDeepMinutes: "sleep",
  sleepRemMinutes: "sleep",
  hrvRmssd: "hrv",
  skinTempDeviationC: "skin_temp",
  stressIndex: "stress",
  vitalityScore: "vitality",
} as const satisfies Record<string, WearableMetric>;
export type SummaryField = keyof typeof FIELD_METRIC;

export type DailySummary = {
  date: string; // YYYY-MM-DD
  wearMinutes: number;
  steps?: number | null;
  activeMinutes?: number | null;
  sleepMinutes?: number | null;
  restingHeartRate?: number | null;
  heartRateMin?: number | null;
  heartRateMax?: number | null;
  spo2Min?: number | null;
  fallEvents?: number | null;
  sosEvents?: number | null;
  /** contract 0.2 (ring-type devices, e.g. SIGRING100 — docs/SIGRING_INTEGRATION.md) */
  sleepDeepMinutes?: number | null;
  sleepRemMinutes?: number | null;
  hrvRmssd?: number | null;
  /** deviation from the person's own usual skin temperature (device-computed), NOT body temperature */
  skinTempDeviationC?: number | null;
  stressIndex?: number | null;
  vitalityScore?: number | null;
};

/** Fields present in a summary whose consent category was not granted. */
export function fieldsOutsideConsent(s: DailySummary, granted: readonly string[]): SummaryField[] {
  return (Object.keys(FIELD_METRIC) as SummaryField[]).filter((f) => s[f] !== undefined && s[f] !== null && !granted.includes(FIELD_METRIC[f]));
}

export const SIGNAL_TYPES = [
  "fall_reported",
  "sos_reported",
  "spo2_low_reported",
  "no_data",
  "low_wear",
  "activity_drop",
  "sleep_change",
  "resting_hr_change",
  "vitality_drop",
  "hrv_drop",
  "skin_temp_rise",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
export const SIGNAL_LABEL: Record<SignalType, string> = {
  fall_reported: "낙상 감지 기록(기기 보고)",
  sos_reported: "SOS 버튼 기록",
  spo2_low_reported: "낮은 산소포화도 기록",
  no_data: "요약 수신 없음",
  low_wear: "착용 시간 부족",
  activity_drop: "활동량 감소",
  sleep_change: "수면 시간 변화",
  resting_hr_change: "안정 시 심박 변화",
  vitality_drop: "활력 지수 하락",
  hrv_drop: "심박변이도(HRV) 감소",
  skin_temp_rise: "피부 온도 상승(평소 대비)",
};
/** Device-reported events and missing data are checked the same day; baseline changes the next day. */
export const SIGNAL_DUE_DAYS: Record<SignalType, number> = {
  fall_reported: 0, sos_reported: 0, spo2_low_reported: 0, no_data: 1, low_wear: 1, activity_drop: 1, sleep_change: 1, resting_hr_change: 1,
  vitality_drop: 1, hrv_drop: 1, skin_temp_rise: 0,
};

export const SIGNAL_STATUSES = ["open", "acknowledged", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];
export const SIGNAL_STATUS_LABEL: Record<SignalStatus, string> = { open: "확인 필요", acknowledged: "확인 완료", dismissed: "해당 없음" };

/** All thresholds in one place (tenant-configurable after the pilot). */
export const SIGNAL_RULES = {
  baselineWindowDays: 14,
  baselineMinDays: 5,
  baselineMinWearMinutes: 600,
  lowWearMinutes: 240,
  activityDropRatio: 0.5,
  activityMinBaselineSteps: 500,
  sleepChangeMinutes: 120,
  restingHrChangeBpm: 15,
  spo2LowPercent: 90,
  noDataHours: 48,
  vitalityDropPoints: 10,
  hrvDropRatio: 0.7,
  hrvMinBaselineMs: 15,
  skinTempRiseC: 1.0,
} as const;

export type SignalBasis = { metric?: string; value?: number; baseline?: number; threshold?: number; baselineDays?: number; hours?: number };
export type Signal = { type: SignalType; date: string; basis: SignalBasis; message: string };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const hm = (min: number) => `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ""}`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const num = (n: number) => n.toLocaleString("ko-KR");
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export type Baseline = { days: number; steps: number | null; sleepMinutes: number | null; restingHeartRate: number | null; vitalityScore: number | null; hrvRmssd: number | null };

/** Median of well-worn days in the window before `date`. `days` < baselineMinDays → no comparison signals. */
export function baselineFor(history: DailySummary[], date: string, rules = SIGNAL_RULES): Baseline {
  const window = history.filter((h) => {
    const d = dayDiff(date, h.date);
    return d >= 1 && d <= rules.baselineWindowDays && h.wearMinutes >= rules.baselineMinWearMinutes;
  });
  const pick = (f: (h: DailySummary) => number | null | undefined) => {
    const xs = window.map(f).filter((v): v is number => typeof v === "number");
    return xs.length >= rules.baselineMinDays ? median(xs) : null;
  };
  return {
    days: window.length, steps: pick((h) => h.steps), sleepMinutes: pick((h) => h.sleepMinutes), restingHeartRate: pick((h) => h.restingHeartRate),
    vitalityScore: pick((h) => h.vitalityScore), hrvRmssd: pick((h) => h.hrvRmssd),
  };
}

/** Signals for one day. `history` may include the day itself; only earlier days form the baseline. */
export function evaluateDay(day: DailySummary, history: DailySummary[], rules = SIGNAL_RULES): Signal[] {
  const out: Signal[] = [];
  const add = (type: SignalType, basis: SignalBasis, message: string) => out.push({ type, date: day.date, basis, message });

  if ((day.fallEvents ?? 0) > 0)
    add("fall_reported", { metric: "fallEvents", value: day.fallEvents! }, `기기가 낙상 감지를 ${day.fallEvents}회 기록했습니다. 실제 낙상 여부는 확인되지 않았습니다.`);
  if ((day.sosEvents ?? 0) > 0)
    add("sos_reported", { metric: "sosEvents", value: day.sosEvents! }, `기기에 SOS 버튼 기록이 ${day.sosEvents}회 있습니다. 실시간 대응 여부를 기기 사업자에 확인하세요.`);
  if (typeof day.spo2Min === "number" && day.spo2Min < rules.spo2LowPercent)
    add("spo2_low_reported", { metric: "spo2Min", value: day.spo2Min, threshold: rules.spo2LowPercent }, `기기 측정 최저 산소포화도 ${day.spo2Min}% 기록 — 측정 오류일 수 있어 확인이 필요합니다.`);

  if (day.wearMinutes < rules.lowWearMinutes) {
    // Too little wear: comparison metrics for this day are not meaningful.
    add("low_wear", { metric: "wearMinutes", value: day.wearMinutes, threshold: rules.lowWearMinutes }, `착용 시간 ${hm(day.wearMinutes)} — 미착용 또는 충전 상태 확인이 필요합니다.`);
    return out;
  }

  const b = baselineFor(history, day.date, rules);
  if (typeof day.steps === "number" && b.steps !== null && b.steps >= rules.activityMinBaselineSteps && day.steps < b.steps * rules.activityDropRatio)
    add("activity_drop", { metric: "steps", value: day.steps, baseline: b.steps, threshold: rules.activityDropRatio, baselineDays: b.days },
      `걸음 수 ${num(day.steps)}보, 평소(중앙값 ${num(b.steps)}보)의 ${Math.round((day.steps / b.steps) * 100)}%입니다.`);
  if (typeof day.sleepMinutes === "number" && b.sleepMinutes !== null && Math.abs(day.sleepMinutes - b.sleepMinutes) >= rules.sleepChangeMinutes)
    add("sleep_change", { metric: "sleepMinutes", value: day.sleepMinutes, baseline: b.sleepMinutes, threshold: rules.sleepChangeMinutes, baselineDays: b.days },
      `수면 ${hm(day.sleepMinutes)}, 평소 ${hm(b.sleepMinutes)} 대비 ${signed(day.sleepMinutes - b.sleepMinutes)}분입니다.`);
  if (typeof day.restingHeartRate === "number" && b.restingHeartRate !== null && Math.abs(day.restingHeartRate - b.restingHeartRate) >= rules.restingHrChangeBpm)
    add("resting_hr_change", { metric: "restingHeartRate", value: day.restingHeartRate, baseline: b.restingHeartRate, threshold: rules.restingHrChangeBpm, baselineDays: b.days },
      `안정 시 심박 ${day.restingHeartRate}bpm, 평소 ${b.restingHeartRate}bpm 대비 ${signed(day.restingHeartRate - b.restingHeartRate)}입니다.`);
  if (typeof day.vitalityScore === "number" && b.vitalityScore !== null && b.vitalityScore - day.vitalityScore >= rules.vitalityDropPoints)
    add("vitality_drop", { metric: "vitalityScore", value: day.vitalityScore, baseline: b.vitalityScore, threshold: rules.vitalityDropPoints, baselineDays: b.days },
      `기기 활력 지수 ${day.vitalityScore}점, 평소 ${b.vitalityScore}점보다 ${b.vitalityScore - day.vitalityScore}점 낮습니다. 컨디션 확인이 필요합니다.`);
  if (typeof day.hrvRmssd === "number" && b.hrvRmssd !== null && b.hrvRmssd >= rules.hrvMinBaselineMs && day.hrvRmssd < b.hrvRmssd * rules.hrvDropRatio)
    add("hrv_drop", { metric: "hrvRmssd", value: day.hrvRmssd, baseline: b.hrvRmssd, threshold: rules.hrvDropRatio, baselineDays: b.days },
      `심박변이도(RMSSD) ${day.hrvRmssd}ms, 평소 ${b.hrvRmssd}ms의 ${Math.round((day.hrvRmssd / b.hrvRmssd) * 100)}%입니다. 피로·수면 부족·몸살 등 여부를 확인하세요.`);
  // The device already expresses skin temperature relative to the person's usual value; no baseline window needed.
  if (typeof day.skinTempDeviationC === "number" && day.skinTempDeviationC >= rules.skinTempRiseC)
    add("skin_temp_rise", { metric: "skinTempDeviationC", value: day.skinTempDeviationC, threshold: rules.skinTempRiseC },
      `손가락 피부 온도가 평소보다 ${day.skinTempDeviationC.toFixed(1)}℃ 높습니다(체온 아님). 발열 등 불편 여부를 전화로 확인하세요.`);
  return out;
}

/** `no_data` when the last summary arrived more than `noDataHours` ago (or never, counted from pairing). */
export function noDataSignal(lastReceivedAt: Date | null, pairedAt: Date, now: Date, rules = SIGNAL_RULES): Signal | null {
  const since = lastReceivedAt ?? pairedAt;
  const hours = Math.floor((now.getTime() - since.getTime()) / 3_600_000);
  if (hours < rules.noDataHours) return null;
  return {
    type: "no_data",
    date: now.toISOString().slice(0, 10),
    basis: { hours, threshold: rules.noDataHours },
    message: `${hours}시간 동안 요약이 수신되지 않았습니다. 미착용·충전·통신 상태 확인이 필요합니다.`,
  };
}
