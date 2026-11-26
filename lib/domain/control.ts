/**
 * 통합 관제 (integrated control view) — subject status, provisional vital thresholds, location display rules.
 * See docs/CONTROL_DASHBOARD.md.
 *
 *  - Not a medical device and not a replacement for 119 / 응급안전안심서비스. "긴급" means "담당자가 즉시 확인해야 함",
 *    never a clinical determination.
 *  - VITAL thresholds below are PROVISIONAL placeholders. They must be reviewed and replaced by clinicians before any
 *    real operation; every screen that uses them says so.
 *  - Location: the current position is shown ONLY with an active, separate location consent AND a fresh fix.
 *    Otherwise only the designated location (거주지 등, approximate) is shown, and it is labelled as such.
 */

export const SUBJECT_STATUSES = ["urgent", "caution", "in_service", "normal", "unlinked"] as const;
export type SubjectStatus = (typeof SUBJECT_STATUSES)[number];
export const SUBJECT_STATUS_LABEL: Record<SubjectStatus, string> = {
  urgent: "긴급",
  caution: "주의",
  in_service: "서비스 중",
  normal: "정상",
  unlinked: "미연결",
};
export const SUBJECT_STATUS_COLOR: Record<SubjectStatus, string> = {
  urgent: "#d92d20",
  caution: "#f5a400",
  in_service: "#2f6fec",
  normal: "#2e9e5b",
  unlinked: "#8a93a3",
};

/** PROVISIONAL — 의료진 검토 전 임시 기준. Replace via clinical review before operation. */
export const PROVISIONAL_VITAL_THRESHOLDS = {
  reviewed: false,
  heartRate: { urgentHigh: 120, urgentLow: 45, cautionHigh: 100, cautionLow: 50 },
  bodyTempC: { urgentHigh: 38.5, cautionHigh: 37.5, cautionLow: 35.5 },
  spo2: { urgentBelow: 90, cautionBelow: 94 },
} as const;

/** A reading older than this is not treated as "current". */
export const READING_FRESH_MINUTES = 120;
/** A location fix older than this is not shown as the current position. */
export const LOCATION_FRESH_MINUTES = 30;

export const READING_EVENTS = ["fall", "sos"] as const;
export type ReadingEvent = (typeof READING_EVENTS)[number];

export type Reading = { measuredAt: string; heartRate?: number | null; bodyTempC?: number | null; spo2?: number | null; event?: ReadingEvent | null };

export const ALERT_KINDS = ["sos", "fall", "vital_urgent", "vital_caution"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_SEVERITY: Record<AlertKind, "urgent" | "caution"> = { sos: "urgent", fall: "urgent", vital_urgent: "urgent", vital_caution: "caution" };
export const ALERT_KIND_LABEL: Record<AlertKind, string> = { sos: "SOS 호출", fall: "낙상 감지", vital_urgent: "측정값 긴급 범위", vital_caution: "측정값 주의 범위" };
export const ALERT_STATUSES = ["open", "in_progress", "resolved"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = { open: "확인 필요", in_progress: "대응 중", resolved: "종결" };

export type VitalFinding = { kind: "vital_urgent" | "vital_caution"; parts: string[] };

/** Classify one reading against the provisional thresholds. Missing values are never "normal" — they are just absent. */
export function evaluateReading(r: Reading): { events: ReadingEvent[]; vital: VitalFinding | null } {
  const t = PROVISIONAL_VITAL_THRESHOLDS;
  const urgent: string[] = [];
  const caution: string[] = [];
  if (typeof r.heartRate === "number") {
    if (r.heartRate >= t.heartRate.urgentHigh || r.heartRate <= t.heartRate.urgentLow) urgent.push(`심박 ${r.heartRate}bpm`);
    else if (r.heartRate >= t.heartRate.cautionHigh || r.heartRate <= t.heartRate.cautionLow) caution.push(`심박 ${r.heartRate}bpm`);
  }
  if (typeof r.bodyTempC === "number") {
    if (r.bodyTempC >= t.bodyTempC.urgentHigh) urgent.push(`체온 ${r.bodyTempC.toFixed(1)}℃`);
    else if (r.bodyTempC >= t.bodyTempC.cautionHigh || r.bodyTempC <= t.bodyTempC.cautionLow) caution.push(`체온 ${r.bodyTempC.toFixed(1)}℃`);
  }
  if (typeof r.spo2 === "number") {
    if (r.spo2 < t.spo2.urgentBelow) urgent.push(`SpO₂ ${r.spo2}%`);
    else if (r.spo2 < t.spo2.cautionBelow) caution.push(`SpO₂ ${r.spo2}%`);
  }
  const events = r.event ? [r.event] : [];
  const vital: VitalFinding | null = urgent.length ? { kind: "vital_urgent", parts: [...urgent, ...caution] } : caution.length ? { kind: "vital_caution", parts: caution } : null;
  return { events, vital };
}

export function alertMessage(kind: AlertKind, parts: string[] = []): string {
  if (kind === "sos") return "기기에서 SOS 호출이 기록되었습니다. 대상자 상태를 즉시 확인하세요.";
  if (kind === "fall") return "기기에서 낙상 감지가 기록되었습니다. 대상자 상태를 즉시 확인하세요.";
  const range = kind === "vital_urgent" ? "긴급" : "주의";
  return `${parts.join(" · ")} — 임시 기준 ${range} 범위 (의료 판단 아님, 확인 필요)`;
}

export type SubjectInputs = {
  hasDevice: boolean;
  readingFresh: boolean;
  openUrgentAlerts: number;
  openCautionAlerts: number;
  openWearableSignals: number;
  visitInProgress: boolean;
};

/** One exclusive status per subject (priority: urgent > caution > in_service > normal > unlinked). */
export function classifySubject(s: SubjectInputs): SubjectStatus {
  if (s.openUrgentAlerts > 0) return "urgent";
  if (s.openCautionAlerts > 0 || s.openWearableSignals > 0 || (s.hasDevice && !s.readingFresh)) return "caution";
  if (s.visitInProgress) return "in_service";
  if (s.hasDevice) return "normal";
  return "unlinked";
}

export type LocationView =
  | { mode: "current"; lat: number; lng: number; accuracyM: number | null; at: string }
  | { mode: "designated"; lat: number; lng: number; label: string; reason: "no_consent" | "stale" | "no_fix" }
  | { mode: "none"; reason: "no_designated" };

/** Current position only with active location consent and a fresh fix; otherwise the designated location. */
export function resolveLocation(
  input: {
    consentActive: boolean;
    fix: { lat: number; lng: number; accuracyM: number | null; at: string } | null;
    designated: { lat: number; lng: number; label: string } | null;
  },
  now = new Date(),
): LocationView {
  if (input.consentActive && input.fix) {
    const ageMin = (now.getTime() - new Date(input.fix.at).getTime()) / 60_000;
    if (ageMin <= LOCATION_FRESH_MINUTES) return { mode: "current", ...input.fix };
  }
  if (!input.designated) return { mode: "none", reason: "no_designated" };
  const reason = !input.consentActive ? "no_consent" : input.fix ? "stale" : "no_fix";
  return { mode: "designated", ...input.designated, reason };
}
export const LOCATION_REASON_LABEL = { no_consent: "위치정보 수집 동의 없음", stale: "실시간 위치 갱신 지연", no_fix: "수신된 위치 없음" } as const;

/** Mockup service groups → existing catalogue codes (no invented service types). */
export const SERVICE_GROUPS = [
  { key: "care", label: "방문요양·가사", types: ["home_care", "housework"] },
  { key: "nursing", label: "방문간호·건강", types: ["visiting_nursing", "visiting_health", "home_medical_link"] },
  { key: "meal", label: "식사지원", types: ["meal"] },
  { key: "mobility", label: "이동지원", types: ["mobility"] },
  { key: "other", label: "기타", types: ["home_modification", "ltc_link", "cognitive_emotional", "social_participation", "family_caregiver", "local_special"] },
] as const;
export type ServiceGroupKey = (typeof SERVICE_GROUPS)[number]["key"];
export const serviceGroupOf = (t: string): ServiceGroupKey => SERVICE_GROUPS.find((g) => (g.types as readonly string[]).includes(t))?.key ?? "other";

export const VISIT_STATUSES = ["scheduled", "in_progress", "completed", "missed"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = { scheduled: "방문 예정", in_progress: "방문 중", completed: "완료", missed: "미방문" };

export const DISPATCH_STATUSES = ["requested", "accepted", "on_site", "completed", "cancelled"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
export const DISPATCH_STATUS_LABEL: Record<DispatchStatus, string> = { requested: "요청됨", accepted: "수락", on_site: "현장 도착", completed: "완료", cancelled: "취소" };
export const DISPATCH_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  requested: ["accepted", "cancelled"],
  accepted: ["on_site", "cancelled"],
  on_site: ["completed"],
  completed: [],
  cancelled: [],
};
