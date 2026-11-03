import {
  ASSESSMENT_DOMAINS,
  ASSESSMENT_DOMAIN_LABEL,
  type AnswerStatus,
  type AssessmentDomain,
  type AssessmentKind,
} from "./enums";

export type AssessmentItemInput = { domain: AssessmentDomain; answerStatus: AnswerStatus | null; value: string; note: string };

/** Domains that must have an explicit answer status before confirmation. */
export const REQUIRED_DOMAINS: AssessmentDomain[] = [...ASSESSMENT_DOMAINS];

/**
 * Validates an assessment before confirmation.
 * A missing/no-response answer is never treated as "normal": it must be
 * explicitly marked, and "confirmed" answers require content.
 */
export function validateAssessmentForConfirm(items: AssessmentItemInput[]): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const byDomain = new Map(items.map((i) => [i.domain, i]));
  for (const d of REQUIRED_DOMAINS) {
    const it = byDomain.get(d);
    if (!it || !it.answerStatus) {
      issues.push({ path: d, message: `${ASSESSMENT_DOMAIN_LABEL[d]}: 응답 상태를 선택해 주세요.` });
      continue;
    }
    if (it.answerStatus === "confirmed" && it.value.trim().length < 2) {
      issues.push({ path: d, message: `${ASSESSMENT_DOMAIN_LABEL[d]}: '확인됨'은 확인 내용을 입력해야 합니다.` });
    }
    if ((it.answerStatus === "needs_followup" || it.answerStatus === "unconfirmed") && it.note.trim().length < 2) {
      issues.push({ path: d, message: `${ASSESSMENT_DOMAIN_LABEL[d]}: 추가 확인 계획 또는 사유를 메모에 입력해 주세요.` });
    }
  }
  return issues;
}

/** Only users explicitly authorised (ABAC attribute) may confirm the official determination. */
export function canConfirmAssessment(kind: AssessmentKind, actor: { canConfirmOfficialDetermination: boolean; isAdmin: boolean; isAssigned: boolean }): boolean {
  if (kind === "official_determination") return actor.canConfirmOfficialDetermination;
  return actor.isAdmin || actor.isAssigned;
}

/** Summary counts used in the UI so "no response" is visible, not silently "normal". */
export function answerSummary(items: { answerStatus: AnswerStatus | null }[]) {
  const s = { confirmed: 0, unconfirmed: 0, no_response: 0, not_applicable: 0, needs_followup: 0, missing: 0 };
  for (const i of items) {
    if (!i.answerStatus) s.missing++;
    else s[i.answerStatus]++;
  }
  s.missing += Math.max(0, REQUIRED_DOMAINS.length - items.length);
  return s;
}
