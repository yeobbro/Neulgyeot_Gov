/**
 * Inbound Hospital → Municipality discharge-care referral DTO (municipality side).
 *
 * ILLUSTRATIVE CONTRACT. This mirrors the demo envelope produced by the
 * Neulgyeot Hospital mock adapter (schemaVersion "1.0"). It is NOT a
 * government or municipal standard. A production contract must follow the
 * agreement and specification approved by each municipality and partner.
 */
import { z } from "zod";

export const SUPPORTED_SCHEMA_VERSIONS = ["1.0"] as const;

export const TRANSFER_CATEGORIES = [
  "identity",
  "discharge",
  "principalDiagnosis",
  "kAdl",
  "fallRisk",
  "cognition",
  "medicationSummary",
  "livingNeeds",
  "socialWorkerNote",
] as const;
export type TransferCategory = (typeof TRANSFER_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<TransferCategory, string> = {
  identity: "기본 식별정보",
  discharge: "퇴원 예정 정보",
  principalDiagnosis: "주진단",
  kAdl: "일상생활 기능(K-ADL 3항목)",
  fallRisk: "낙상 위험 구간",
  cognition: "인지·의사소통 상태",
  medicationSummary: "투약 요약",
  livingNeeds: "생활환경·요청 서비스",
  socialWorkerNote: "사회복지사 소견",
};

/** Health-related categories → need separate sensitive-information consent (개인정보 보호법 제23조). */
export const SENSITIVE_CATEGORIES: TransferCategory[] = [
  "principalDiagnosis",
  "kAdl",
  "fallRisk",
  "cognition",
  "medicationSummary",
];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다.");
const datetime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/, "ISO 8601 일시여야 합니다.");
const shortText = (max: number) => z.string().trim().max(max);

export const referralEnvelopeSchema = z
  .object({
    schemaVersion: z.enum(SUPPORTED_SCHEMA_VERSIONS),
    transferId: z.string().regex(/^[A-Za-z0-9._:-]{6,80}$/, "transferId 형식이 올바르지 않습니다."),
    eventType: z.literal("discharge-care-referral"),
    traceId: z.string().regex(/^[A-Za-z0-9._:-]{6,80}$/).optional(),
    source: z.object({
      facilityId: z.string().regex(/^[A-Za-z0-9._-]{2,40}$/),
      facilityName: shortText(80).optional(),
    }),
    destination: z.object({ municipalityCode: z.string().regex(/^[A-Za-z0-9-]{2,20}$/) }),
    subject: z.object({
      patientId: z.string().min(1).max(60),
      name: shortText(40).min(1),
      birthDate: date,
      contact: z.null(),
    }),
    discharge: z.object({ plannedDate: date.nullable() }).optional(),
    clinicalSummary: z
      .object({
        principalDiagnosis: z.object({ system: z.literal("KCD"), code: shortText(10), display: shortText(80) }).optional(),
        kAdl: z.object({ eating: shortText(30), mobility: shortText(30), toileting: shortText(30) }).optional(),
        fallRisk: shortText(30).optional(),
        cognition: shortText(40).optional(),
        medicationSummary: z.array(z.object({ name: shortText(60), frequency: shortText(40) })).max(30).optional(),
      })
      .strict()
      .optional(),
    livingNeeds: z
      .object({
        livingArrangement: shortText(60),
        housingType: shortText(60),
        barriers: z.array(shortText(60)).max(10),
        requestedServices: z.array(shortText(60)).min(1).max(12),
        socialWorkerNote: shortText(500).optional(),
      })
      .optional(),
    consent: z.object({
      status: z.enum(["DEMO_GRANTED", "GRANTED"]),
      version: z.string().max(10),
      recordedAt: datetime,
      scope: z.array(z.enum(TRANSFER_CATEGORIES)).min(1),
      sensitiveInformationConsent: z.enum(["notApplicable", "granted", "notGranted"]),
      retention: z.enum(["untilCaseClosure", "oneYear", "threeYears"]),
      legalBasis: shortText(200).optional(),
      purpose: shortText(200).optional(),
    }),
  })
  .strict();

export type ReferralEnvelope = z.infer<typeof referralEnvelopeSchema>;

/** Categories actually present in the payload. */
export function presentCategories(e: ReferralEnvelope): TransferCategory[] {
  const out: TransferCategory[] = ["identity"];
  if (e.discharge) out.push("discharge");
  const c = e.clinicalSummary;
  if (c?.principalDiagnosis) out.push("principalDiagnosis");
  if (c?.kAdl) out.push("kAdl");
  if (c?.fallRisk) out.push("fallRisk");
  if (c?.cognition) out.push("cognition");
  if (c?.medicationSummary) out.push("medicationSummary");
  if (e.livingNeeds) {
    out.push("livingNeeds");
    if (e.livingNeeds.socialWorkerNote) out.push("socialWorkerNote");
  }
  return out;
}

export const HOSPITAL_SERVICE_TO_TYPE: Record<string, string> = {
  "방문 간호": "visiting_nursing",
  "방문간호": "visiting_nursing",
  "식사 지원": "meal",
  "주거 개선": "home_modification",
  "주거환경 개선": "home_modification",
  "이동 지원": "mobility",
  "일상생활 지원": "housework",
  "가사 지원": "housework",
  "방문건강관리": "visiting_health",
  "재가 돌봄": "home_care",
};

export const statusCallbackSchema = z
  .object({
    schemaVersion: z.enum(SUPPORTED_SCHEMA_VERSIONS),
    transferId: z.string().regex(/^[A-Za-z0-9._:-]{6,80}$/),
    event: z.enum(["DISCHARGE_DATE_CHANGED", "REFERRAL_WITHDRAWN", "DISCHARGED"]),
    occurredAt: datetime,
    dischargeDate: date.nullable().optional(),
    note: shortText(200).optional(),
  })
  .strict();
export type StatusCallback = z.infer<typeof statusCallbackSchema>;
