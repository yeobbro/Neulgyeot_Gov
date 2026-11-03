/**
 * Per-category intake decision for an inbound hospital referral.
 *
 * A single "consent = yes" flag never unlocks everything. Each category is
 * checked against (1) the consent scope sent by the hospital, (2) separate
 * sensitive-information consent, (3) the receiving municipality's
 * minimum-necessary intake policy and (4) whether a legal basis was recorded.
 */
import {
  CATEGORY_LABEL,
  SENSITIVE_CATEGORIES,
  presentCategories,
  type ReferralEnvelope,
  type TransferCategory,
} from "./schema";

export type CategoryDecision = "accepted" | "pending_review" | "blocked_by_policy";

export type IntakePolicy = {
  /** Categories the municipality is willing to receive and store. */
  allowedCategories: TransferCategory[];
};

/** Default minimum-necessary policy: no diagnosis and no medication list. */
export const DEFAULT_INTAKE_POLICY: IntakePolicy = {
  allowedCategories: ["identity", "discharge", "kAdl", "fallRisk", "cognition", "livingNeeds", "socialWorkerNote"],
};

export type ConsentEvaluation = {
  ok: boolean;
  /** Fatal problems → the referral is rejected (VALIDATION_FAILED). */
  errors: { path: string; message: string }[];
  decisions: { category: TransferCategory; label: string; sensitive: boolean; decision: CategoryDecision; reason: string }[];
};

export function evaluateConsent(env: ReferralEnvelope, policy: IntakePolicy = DEFAULT_INTAKE_POLICY): ConsentEvaluation {
  const errors: ConsentEvaluation["errors"] = [];
  const present = presentCategories(env);
  const scope = new Set(env.consent.scope);

  for (const c of present) {
    if (!scope.has(c)) {
      errors.push({ path: `consent.scope`, message: `동의 범위에 없는 항목이 포함되어 있습니다: ${CATEGORY_LABEL[c]}` });
    }
  }
  const sensitivePresent = present.filter((c) => SENSITIVE_CATEGORIES.includes(c));
  if (sensitivePresent.length > 0 && env.consent.sensitiveInformationConsent !== "granted") {
    errors.push({
      path: "consent.sensitiveInformationConsent",
      message: "건강 관련 항목이 포함되어 있으나 민감정보 별도 동의가 확인되지 않았습니다.",
    });
  }
  if (!scope.has("identity")) errors.push({ path: "consent.scope", message: "기본 식별정보 항목이 동의 범위에 포함되어야 합니다." });

  const hasLegalBasis = Boolean(env.consent.legalBasis && env.consent.legalBasis.trim().length >= 5);
  const decisions = present.map((category) => {
    const sensitive = SENSITIVE_CATEGORIES.includes(category);
    let decision: CategoryDecision = "accepted";
    let reason = "동의 범위 및 수신 정책 내 항목";
    if (!policy.allowedCategories.includes(category)) {
      decision = "blocked_by_policy";
      reason = "지자체 최소수집 정책상 수신하지 않는 항목 — 저장하지 않음";
    } else if (sensitive && !hasLegalBasis) {
      decision = "pending_review";
      reason = "민감정보 처리 법적 근거 기재 없음 — 담당 검토 전 열람·활용 제한";
    }
    return { category, label: CATEGORY_LABEL[category], sensitive, decision, reason };
  });

  return { ok: errors.length === 0, errors, decisions };
}

/**
 * Builds the payload that is actually stored: blocked categories are removed,
 * direct identifiers are split out, and the hospital patient ID is replaced
 * with an opaque reference.
 */
export function minimizePayload(env: ReferralEnvelope, evaluation: ConsentEvaluation) {
  const allowed = new Set(evaluation.decisions.filter((d) => d.decision !== "blocked_by_policy").map((d) => d.category));
  const c = env.clinicalSummary ?? {};
  const clinical: Record<string, unknown> = {};
  if (allowed.has("kAdl") && c.kAdl) clinical.kAdl = c.kAdl;
  if (allowed.has("fallRisk") && c.fallRisk) clinical.fallRisk = c.fallRisk;
  if (allowed.has("cognition") && c.cognition) clinical.cognition = c.cognition;
  if (allowed.has("principalDiagnosis") && c.principalDiagnosis) clinical.principalDiagnosis = c.principalDiagnosis;
  if (allowed.has("medicationSummary") && c.medicationSummary) clinical.medicationSummary = c.medicationSummary;

  const living = env.livingNeeds && allowed.has("livingNeeds")
    ? {
        livingArrangement: env.livingNeeds.livingArrangement,
        housingType: env.livingNeeds.housingType,
        barriers: env.livingNeeds.barriers,
        requestedServices: env.livingNeeds.requestedServices,
        ...(allowed.has("socialWorkerNote") && env.livingNeeds.socialWorkerNote
          ? { socialWorkerNote: env.livingNeeds.socialWorkerNote }
          : {}),
      }
    : undefined;

  return {
    schemaVersion: env.schemaVersion,
    transferId: env.transferId,
    source: env.source,
    destination: env.destination,
    discharge: allowed.has("discharge") ? env.discharge : undefined,
    functionalSummary: Object.keys(clinical).length ? clinical : undefined,
    livingNeeds: living,
    consent: {
      version: env.consent.version,
      recordedAt: env.consent.recordedAt,
      scope: env.consent.scope,
      sensitiveInformationConsent: env.consent.sensitiveInformationConsent,
      retention: env.consent.retention,
      legalBasis: env.consent.legalBasis ?? null,
      purpose: env.consent.purpose ?? null,
    },
  };
}
export type StoredReferralPayload = ReturnType<typeof minimizePayload>;
