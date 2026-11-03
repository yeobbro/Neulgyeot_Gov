/**
 * Shared enums, Korean labels and server-side state machines.
 * DB CHECK constraints are generated from the same arrays (see migrations).
 */

export const ROLES = ["municipal_admin", "case_manager", "service_provider", "auditor"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  municipal_admin: "시·군·구 관리자",
  case_manager: "사례관리 담당자",
  service_provider: "서비스 제공기관",
  auditor: "감사·점검 담당자",
};

/* ------------------------------------------------------------------ */
/* 병원 연계(Inbound referral) 상태                                      */
/* ------------------------------------------------------------------ */
export const REFERRAL_STATUSES = [
  "RECEIVED",
  "VALIDATION_FAILED",
  "UNDER_REVIEW",
  "NEEDS_INFORMATION",
  "RESUBMITTED",
  "ACCEPTED_FOR_ASSESSMENT",
  "DECLINED",
  "CLOSED",
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
export const REFERRAL_STATUS_LABEL: Record<ReferralStatus, string> = {
  RECEIVED: "신규",
  VALIDATION_FAILED: "검증 실패",
  UNDER_REVIEW: "확인 중",
  NEEDS_INFORMATION: "추가 정보 필요",
  RESUBMITTED: "보완 제출",
  ACCEPTED_FOR_ASSESSMENT: "조사 예정(접수 완료)",
  DECLINED: "반려",
  CLOSED: "종결",
};
export const REFERRAL_TRANSITIONS: Record<ReferralStatus, ReferralStatus[]> = {
  RECEIVED: ["UNDER_REVIEW", "DECLINED"],
  VALIDATION_FAILED: ["RESUBMITTED", "CLOSED"],
  UNDER_REVIEW: ["NEEDS_INFORMATION", "ACCEPTED_FOR_ASSESSMENT", "DECLINED"],
  NEEDS_INFORMATION: ["RESUBMITTED", "CLOSED"],
  RESUBMITTED: ["UNDER_REVIEW"],
  ACCEPTED_FOR_ASSESSMENT: ["CLOSED"],
  DECLINED: ["CLOSED"],
  CLOSED: [],
};

/* ------------------------------------------------------------------ */
/* 사례관리 상태                                                         */
/* ------------------------------------------------------------------ */
export const CASE_STATUSES = [
  "APPLICATION_RECEIVED",
  "PRE_SCREENING",
  "SURVEY_IN_PROGRESS",
  "ASSESSMENT_REVIEW",
  "ASSESSMENT_COMPLETED",
  "SUPPORT_PLAN_DRAFT",
  "MEETING_SCHEDULED",
  "SUPPORT_PLAN_APPROVED",
  "SERVICE_REFERRAL_PENDING",
  "PROVIDER_ACCEPTED",
  "SERVICE_SCHEDULED",
  "SERVICE_ACTIVE",
  "MONITORING_DUE",
  "PLAN_REVIEW",
  "CLOSED",
  "WITHDRAWN",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  APPLICATION_RECEIVED: "신청 접수",
  PRE_SCREENING: "사전 검토",
  SURVEY_IN_PROGRESS: "조사 진행 중",
  ASSESSMENT_REVIEW: "평가 검토",
  ASSESSMENT_COMPLETED: "평가 확정",
  SUPPORT_PLAN_DRAFT: "지원계획 작성",
  MEETING_SCHEDULED: "통합지원회의 예정",
  SUPPORT_PLAN_APPROVED: "지원계획 승인",
  SERVICE_REFERRAL_PENDING: "서비스 의뢰 대기",
  PROVIDER_ACCEPTED: "제공기관 수락",
  SERVICE_SCHEDULED: "서비스 예정",
  SERVICE_ACTIVE: "서비스 제공 중",
  MONITORING_DUE: "모니터링 예정",
  PLAN_REVIEW: "계획 재검토",
  CLOSED: "종결",
  WITHDRAWN: "철회",
};
const ANY_OPEN_TO_EXIT: CaseStatus[] = ["WITHDRAWN"];
export const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  APPLICATION_RECEIVED: ["PRE_SCREENING", "SURVEY_IN_PROGRESS", ...ANY_OPEN_TO_EXIT],
  PRE_SCREENING: ["SURVEY_IN_PROGRESS", "CLOSED", ...ANY_OPEN_TO_EXIT],
  SURVEY_IN_PROGRESS: ["ASSESSMENT_REVIEW", ...ANY_OPEN_TO_EXIT],
  ASSESSMENT_REVIEW: ["SURVEY_IN_PROGRESS", "ASSESSMENT_COMPLETED", ...ANY_OPEN_TO_EXIT],
  ASSESSMENT_COMPLETED: ["SUPPORT_PLAN_DRAFT", "CLOSED", ...ANY_OPEN_TO_EXIT],
  SUPPORT_PLAN_DRAFT: ["MEETING_SCHEDULED", "SUPPORT_PLAN_APPROVED", ...ANY_OPEN_TO_EXIT],
  MEETING_SCHEDULED: ["SUPPORT_PLAN_DRAFT", "SUPPORT_PLAN_APPROVED", ...ANY_OPEN_TO_EXIT],
  SUPPORT_PLAN_APPROVED: ["SERVICE_REFERRAL_PENDING", ...ANY_OPEN_TO_EXIT],
  SERVICE_REFERRAL_PENDING: ["PROVIDER_ACCEPTED", "PLAN_REVIEW", ...ANY_OPEN_TO_EXIT],
  PROVIDER_ACCEPTED: ["SERVICE_SCHEDULED", "SERVICE_REFERRAL_PENDING", ...ANY_OPEN_TO_EXIT],
  SERVICE_SCHEDULED: ["SERVICE_ACTIVE", "SERVICE_REFERRAL_PENDING", ...ANY_OPEN_TO_EXIT],
  SERVICE_ACTIVE: ["MONITORING_DUE", "PLAN_REVIEW", ...ANY_OPEN_TO_EXIT],
  MONITORING_DUE: ["SERVICE_ACTIVE", "PLAN_REVIEW", "CLOSED", ...ANY_OPEN_TO_EXIT],
  PLAN_REVIEW: ["SUPPORT_PLAN_DRAFT", "SERVICE_REFERRAL_PENDING", "SERVICE_ACTIVE", "CLOSED", ...ANY_OPEN_TO_EXIT],
  CLOSED: [],
  WITHDRAWN: [],
};

/* ------------------------------------------------------------------ */
/* 개인별 지원계획 상태                                                   */
/* ------------------------------------------------------------------ */
export const PLAN_STATUSES = [
  "DRAFT",
  "REVIEW_REQUESTED",
  "MEETING_SCHEDULED",
  "NEEDS_REVISION",
  "APPROVED",
  "REFERRING",
  "IN_PROGRESS",
  "CHANGE_REVIEW",
  "CLOSED",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  DRAFT: "작성 중",
  REVIEW_REQUESTED: "검토 요청",
  MEETING_SCHEDULED: "통합지원회의 예정",
  NEEDS_REVISION: "보완 필요",
  APPROVED: "승인 완료",
  REFERRING: "서비스 의뢰 중",
  IN_PROGRESS: "진행 중",
  CHANGE_REVIEW: "변경 검토",
  CLOSED: "종결",
};
export const PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  DRAFT: ["REVIEW_REQUESTED", "CLOSED"],
  REVIEW_REQUESTED: ["MEETING_SCHEDULED", "NEEDS_REVISION", "APPROVED"],
  MEETING_SCHEDULED: ["APPROVED", "NEEDS_REVISION"],
  NEEDS_REVISION: ["DRAFT"],
  APPROVED: ["REFERRING", "CHANGE_REVIEW"],
  REFERRING: ["IN_PROGRESS", "CHANGE_REVIEW"],
  IN_PROGRESS: ["CHANGE_REVIEW", "CLOSED"],
  CHANGE_REVIEW: ["DRAFT", "IN_PROGRESS", "CLOSED"],
  CLOSED: [],
};

/* ------------------------------------------------------------------ */
/* 서비스 의뢰 상태                                                       */
/* ------------------------------------------------------------------ */
export const SERVICE_REFERRAL_STATUSES = [
  "DRAFT",
  "REQUESTED",
  "ACCEPTED",
  "UNAVAILABLE",
  "SCHEDULED",
  "STARTED",
  "COMPLETED",
  "CANCELED",
  "REASSESSMENT_REQUIRED",
] as const;
export type ServiceReferralStatus = (typeof SERVICE_REFERRAL_STATUSES)[number];
export const SERVICE_REFERRAL_STATUS_LABEL: Record<ServiceReferralStatus, string> = {
  DRAFT: "작성 중",
  REQUESTED: "의뢰 전송(제공기관 확인 중)",
  ACCEPTED: "수락",
  UNAVAILABLE: "수행 불가",
  SCHEDULED: "서비스 예정",
  STARTED: "서비스 시작",
  COMPLETED: "서비스 완료",
  CANCELED: "취소",
  REASSESSMENT_REQUIRED: "재연계 필요",
};
export const SERVICE_REFERRAL_TRANSITIONS: Record<ServiceReferralStatus, ServiceReferralStatus[]> = {
  DRAFT: ["REQUESTED", "CANCELED"],
  REQUESTED: ["ACCEPTED", "UNAVAILABLE", "CANCELED"],
  ACCEPTED: ["SCHEDULED", "UNAVAILABLE", "CANCELED"],
  UNAVAILABLE: ["REASSESSMENT_REQUIRED", "CANCELED"],
  SCHEDULED: ["STARTED", "CANCELED", "REASSESSMENT_REQUIRED"],
  STARTED: ["COMPLETED", "REASSESSMENT_REQUIRED"],
  COMPLETED: ["REASSESSMENT_REQUIRED"],
  CANCELED: [],
  REASSESSMENT_REQUIRED: ["CANCELED"],
};
/** Who may perform each service-referral transition. */
export const SERVICE_TRANSITION_ACTOR: Partial<Record<ServiceReferralStatus, "staff" | "provider" | "both">> = {
  REQUESTED: "staff",
  ACCEPTED: "provider",
  UNAVAILABLE: "provider",
  SCHEDULED: "provider",
  STARTED: "provider",
  COMPLETED: "provider",
  CANCELED: "staff",
  REASSESSMENT_REQUIRED: "both",
};

export function canTransition<S extends string>(map: Record<S, S[]>, from: S, to: S): boolean {
  return (map[from] ?? []).includes(to);
}

/* ------------------------------------------------------------------ */
/* 서비스 유형 (기본 카탈로그 — 지자체별 설정 테이블로 확장 가능)           */
/* ------------------------------------------------------------------ */
export const SERVICE_TYPES = [
  "visiting_nursing",
  "visiting_health",
  "home_medical_link",
  "meal",
  "mobility",
  "housework",
  "home_modification",
  "home_care",
  "ltc_link",
  "cognitive_emotional",
  "social_participation",
  "family_caregiver",
  "local_special",
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  visiting_nursing: "방문간호",
  visiting_health: "방문건강관리",
  home_medical_link: "방문진료 연계",
  meal: "식사 지원",
  mobility: "이동 지원",
  housework: "가사 지원",
  home_modification: "주거환경 개선",
  home_care: "재가 돌봄",
  ltc_link: "장기요양 연계",
  cognitive_emotional: "인지·정서 지원",
  social_participation: "사회참여 프로그램",
  family_caregiver: "가족 돌봄 지원",
  local_special: "기타 지자체 특화 서비스",
};

export const CAPACITY_STATUSES = ["available", "limited", "full", "unknown"] as const;
export type CapacityStatus = (typeof CAPACITY_STATUSES)[number];
export const CAPACITY_LABEL: Record<CapacityStatus, string> = {
  available: "수용 가능",
  limited: "제한적 수용",
  full: "수용 불가(대기)",
  unknown: "확인 필요",
};

/* ------------------------------------------------------------------ */
/* 조사·평가                                                            */
/* ------------------------------------------------------------------ */
export const ASSESSMENT_DOMAINS = [
  "basic_profile",
  "household",
  "housing",
  "mobility_adl",
  "nutrition",
  "health_service_use",
  "ltc_care_needs",
  "social_relations",
  "family_burden",
  "recipient_wishes",
  "surveyor_opinion",
] as const;
export type AssessmentDomain = (typeof ASSESSMENT_DOMAINS)[number];
export const ASSESSMENT_DOMAIN_LABEL: Record<AssessmentDomain, string> = {
  basic_profile: "대상자 기본 특성",
  household: "거주 및 가구 형태",
  housing: "주거 환경",
  mobility_adl: "이동 및 일상생활",
  nutrition: "식사 및 영양 관련 지원 필요",
  health_service_use: "보건의료 서비스 이용 및 연계 필요",
  ltc_care_needs: "장기요양 및 돌봄 욕구",
  social_relations: "사회적 관계·고립 관련 지원 욕구",
  family_burden: "가족 돌봄 부담",
  recipient_wishes: "대상자 본인이 원하는 지원",
  surveyor_opinion: "담당자 조사 의견",
};
export const ANSWER_STATUSES = ["confirmed", "unconfirmed", "no_response", "not_applicable", "needs_followup"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];
export const ANSWER_STATUS_LABEL: Record<AnswerStatus, string> = {
  confirmed: "확인됨",
  unconfirmed: "확인되지 않음",
  no_response: "대상자가 응답하지 않음",
  not_applicable: "해당 없음",
  needs_followup: "추가 확인 필요",
};
export const ASSESSMENT_KINDS = ["municipal_survey", "official_determination"] as const;
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];
export const ASSESSMENT_KIND_LABEL: Record<AssessmentKind, string> = {
  municipal_survey: "지자체 자체조사",
  official_determination: "제도상 통합판정(권한자 확정)",
};
export const ASSESSMENT_STATUSES = ["draft", "submitted", "confirmed"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];
export const ASSESSMENT_STATUS_LABEL: Record<AssessmentStatus, string> = {
  draft: "작성 중",
  submitted: "검토 요청",
  confirmed: "확정",
};

export const INTAKE_ROUTES = ["hospital_referral", "self_application", "agency_referral", "outreach"] as const;
export type IntakeRoute = (typeof INTAKE_ROUTES)[number];
export const INTAKE_ROUTE_LABEL: Record<IntakeRoute, string> = {
  hospital_referral: "병원 퇴원 연계",
  self_application: "본인·가족 신청",
  agency_referral: "기관 의뢰",
  outreach: "발굴(찾아가는 상담)",
};

export const MONITORING_METHODS = ["visit", "phone", "other"] as const;
export type MonitoringMethod = (typeof MONITORING_METHODS)[number];
export const MONITORING_METHOD_LABEL: Record<MonitoringMethod, string> = { visit: "방문", phone: "전화", other: "기타" };

export const RECORD_TYPES = ["consultation", "visit", "phone", "note"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  consultation: "상담",
  visit: "방문",
  phone: "전화",
  note: "업무 메모",
};

export const TASK_TYPES = [
  "monitoring_due",
  "visit_planned",
  "contact_needed",
  "service_not_delivered",
  "service_change",
  "provider_change",
  "closure_review",
  "referral_review",
  "info_request_followup",
  "assessment_due",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  monitoring_due: "모니터링 기한 도래",
  visit_planned: "방문 예정",
  contact_needed: "연락 필요",
  service_not_delivered: "서비스 미수행",
  service_change: "서비스 변경 필요",
  provider_change: "기관 변경 필요",
  closure_review: "사례 종결 검토",
  referral_review: "연계 신청 검토",
  info_request_followup: "보완 자료 확인",
  assessment_due: "조사 예정",
};
export const TASK_STATUSES = ["open", "done", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
