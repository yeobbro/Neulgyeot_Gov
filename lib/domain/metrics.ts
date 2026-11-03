import type { CaseStatus } from "./enums";

/** Dashboard status groups. Each metric links to the case list with ?group=<key>. */
export const STATUS_GROUPS: Record<string, { label: string; statuses: CaseStatus[]; definition: string }> = {
  new: { label: "신규 접수", statuses: ["APPLICATION_RECEIVED"], definition: "사례 상태가 '신청 접수'인 사례" },
  survey_wait: { label: "조사 대기", statuses: ["PRE_SCREENING"], definition: "사전 검토를 마치고 조사를 기다리는 사례" },
  survey: { label: "조사 진행 중", statuses: ["SURVEY_IN_PROGRESS", "ASSESSMENT_REVIEW"], definition: "조사 진행 또는 평가 검토 중인 사례" },
  plan_wait: { label: "지원계획 작성 대기", statuses: ["ASSESSMENT_COMPLETED", "SUPPORT_PLAN_DRAFT"], definition: "평가 확정 후 계획 작성 중이거나 작성 전인 사례" },
  meeting: { label: "통합지원회의 대기", statuses: ["MEETING_SCHEDULED"], definition: "통합지원회의가 예정된 사례" },
  referral_wait: { label: "서비스 의뢰 대기", statuses: ["SUPPORT_PLAN_APPROVED", "SERVICE_REFERRAL_PENDING"], definition: "계획 승인 후 의뢰 전이거나 기관 회신 대기 중인 사례" },
  active: { label: "서비스 제공 중", statuses: ["PROVIDER_ACCEPTED", "SERVICE_SCHEDULED", "SERVICE_ACTIVE"], definition: "기관 수락·일정 확정·서비스 제공 중인 사례" },
  monitoring: { label: "모니터링 예정", statuses: ["MONITORING_DUE"], definition: "모니터링 예정일이 도래한 사례" },
  plan_review: { label: "계획 재검토", statuses: ["PLAN_REVIEW"], definition: "모니터링 결과 등으로 계획 재검토가 필요한 사례" },
};

export const OPEN_EXCLUDED: CaseStatus[] = ["CLOSED", "WITHDRAWN"];

/** Small-cell suppression for aggregate displays (k-anonymity style). */
export const SMALL_CELL = 3;
export function suppress(n: number, enabled: boolean): string {
  if (!enabled) return String(n);
  if (n === 0) return "0";
  return n < SMALL_CELL ? `<${SMALL_CELL}` : String(n);
}
