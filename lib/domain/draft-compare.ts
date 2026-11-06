/**
 * Side-by-side comparison of a rule draft and an AI draft (pure, no I/O). Used by the review UI.
 * It only describes differences — it does not judge which draft is better. Evidence validity is enforced on
 * the server when the AI draft is created (composeDraft); this function never re-validates or trusts the UI.
 */
import type { DraftContent } from "./ai-draft";

export type SentenceMark = "same" | "ai_only" | "rule_only";
export type ComparedSentence = { text: string; factIds: string[]; mark: SentenceMark; newEvidence: string[] };
export type ComparedSection = { title: string; rule: ComparedSentence[]; ai: ComparedSentence[]; aiEngine: "rules" | "ai-intelligence" | null };
export type DraftComparison = { sections: ComparedSection[]; summary: { same: number; aiOnly: number; ruleOnly: number } };

const key = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim();

export function compareDrafts(rule: DraftContent, ai: DraftContent, sectionEngines?: (string | undefined)[]): DraftComparison {
  const titles = [...rule.sections.map((s) => s.title), ...ai.sections.map((s) => s.title).filter((t) => !rule.sections.some((r) => r.title === t))];
  const summary = { same: 0, aiOnly: 0, ruleOnly: 0 };
  const sections = titles.map((title): ComparedSection => {
    const r = rule.sections.find((s) => s.title === title)?.sentences ?? [];
    const aiIdx = ai.sections.findIndex((s) => s.title === title);
    const a = aiIdx >= 0 ? ai.sections[aiIdx].sentences : [];
    const ruleKeys = new Set(r.map((x) => key(x.text)));
    const aiKeys = new Set(a.map((x) => key(x.text)));
    const ruleFacts = new Set(r.flatMap((x) => x.factIds));
    const ruleOut: ComparedSentence[] = r.map((x) => {
      const mark: SentenceMark = aiKeys.has(key(x.text)) ? "same" : "rule_only";
      if (mark === "rule_only") summary.ruleOnly++;
      return { text: x.text, factIds: x.factIds, mark, newEvidence: [] };
    });
    const aiOut: ComparedSentence[] = a.map((x) => {
      const mark: SentenceMark = ruleKeys.has(key(x.text)) ? "same" : "ai_only";
      if (mark === "same") summary.same++;
      else summary.aiOnly++;
      return { text: x.text, factIds: x.factIds, mark, newEvidence: x.factIds.filter((f) => !ruleFacts.has(f)) };
    });
    const eng = aiIdx >= 0 ? sectionEngines?.[aiIdx] : undefined;
    return { title, rule: ruleOut, ai: aiOut, aiEngine: eng === "rules" || eng === "ai-intelligence" ? eng : null };
  });
  return { sections, summary };
}
