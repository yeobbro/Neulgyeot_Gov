/**
 * AI-draft structure and verification (pure, testable).
 * Every sentence must cite at least one source fact that exists in the
 * fact set given to the generator; otherwise the draft is rejected.
 */
import { z } from "zod";

export type Fact = { id: string; text: string; sourceType: string; sourceId: string; field: string };

export const draftSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        sentences: z.array(z.object({ text: z.string().min(2).max(400), factIds: z.array(z.string().max(10)).min(1).max(8) })).max(12),
      }),
    )
    .min(1)
    .max(8),
});
export type DraftContent = z.infer<typeof draftSchema>;

/** Phrases the assistant must not produce: eligibility, urgency/risk judgments, diagnoses or prognoses. */
export const FORBIDDEN_PATTERNS: RegExp[] = [
  /자격(이|을)?\s*(있|없|충족|해당)/,
  /수급\s*(대상|권리)/,
  /대상자에\s*해당/,
  /긴급(하|한|히|성)/,
  /위험(이|도|성)?\s*(높|낮|크)/,
  /진단(됨|된다|으로 보임|이 의심)/,
  /예후/,
  /(치매|우울증|파킨슨)(으로|이)\s*(보|추정|의심)/,
  /고집|비협조적|문제\s*노인/,
];

export function verifyDraft(content: DraftContent, facts: Fact[]): { ok: boolean; problems: string[] } {
  const ids = new Set(facts.map((f) => f.id));
  const problems: string[] = [];
  content.sections.forEach((s, si) =>
    s.sentences.forEach((sen, i) => {
      const missing = sen.factIds.filter((f) => !ids.has(f));
      if (missing.length) problems.push(`${si + 1}-${i + 1}: 존재하지 않는 근거 ${missing.join(",")}`);
      for (const p of FORBIDDEN_PATTERNS) if (p.test(sen.text)) problems.push(`${si + 1}-${i + 1}: 판단·낙인 표현 금지 (${p.source})`);
    }),
  );
  return { ok: problems.length === 0, problems };
}

/** Builds the readable draft text with citation markers, e.g. "… [F3]". */
export function renderDraft(content: DraftContent): string {
  return content.sections
    .map((s, i) => `${i + 1}. ${s.title}\n${s.sentences.map((x) => `- ${x.text} [${x.factIds.join(", ")}]`).join("\n") || "- (근거 자료 없음)"}`)
    .join("\n\n");
}
