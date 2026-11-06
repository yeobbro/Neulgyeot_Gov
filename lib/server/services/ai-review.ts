/**
 * Draft review workflow (compare → select → approve). A GROUP is one rule draft (the root, id = draft_group_id)
 * plus the AI proposals made from it. Rules:
 *   - SELECT chooses which draft will go to approval. It is NOT approval and writes no official record.
 *   - Only one draft per group can be selected and only one approved (unique indexes; rows locked in id order).
 *   - Once a draft in the group is approved, nothing in the group can be selected, re-selected or approved.
 *   - Discarded drafts can be neither selected nor approved.
 *   - HOLD keeps every draft as a candidate (compare later); nothing is discarded.
 * Permissions: viewing = read access to the target; select / hold = the same write rule as approve.
 */
import { compareDrafts, type DraftComparison } from "../../domain/draft-compare";
import type { DraftContent, Fact } from "../../domain/ai-draft";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { AppError, conflict, notFound } from "../errors";
import { assertDraftRead, latestJobForDraft, type JobView } from "../ai/jobs";
import { assertDraftReview } from "./ai";

type Row = {
  id: string; case_id: string | null; referral_id: string | null; kind: string; engine: string; status: string; selection_status: string;
  draft_group_id: string; content: DraftContent & { facts: Fact[]; text: string; ai?: { sectionEngines?: string[]; model?: string | null; promptVersion?: string | null; aiRequestId?: string | null } };
  edited_text: string | null; created_at: string | Date; reviewed_at: string | Date | null; selected_at: string | Date | null; source_job_id: string | null;
  creator: string; reviewer: string | null; selector: string | null;
};
const COLS = `d.id, d.case_id, d.referral_id, d.kind, d.engine, d.status, d.selection_status, d.draft_group_id, d.content, d.edited_text,
  d.created_at, d.reviewed_at, d.selected_at, d.source_job_id, u.display_name AS creator, ru.display_name AS reviewer, su.display_name AS selector`;
const FROM = `FROM ai_drafts d JOIN users u ON u.id = d.created_by LEFT JOIN users ru ON ru.id = d.reviewed_by LEFT JOIN users su ON su.id = d.selected_by`;

export type DraftGroupView = {
  groupId: string; kind: string; target: { caseId: string | null; referralId: string | null };
  drafts: (Omit<Row, "content"> & { content: Row["content"]; isRoot: boolean; source: "rule_based" | "ai" })[];
  selectedDraftId: string | null; approvedDraftId: string | null;
  job: JobView | null; comparison: { ruleDraftId: string; aiDraftId: string; result: DraftComparison } | null;
};

function toView(rows: Row[], job: JobView | null): DraftGroupView {
  const root = rows.find((r) => r.id === r.draft_group_id) ?? rows[0];
  const drafts = rows
    .map((r) => ({ ...r, isRoot: r.id === r.draft_group_id, source: (r.engine === "rules" || r.engine === "llm" ? "rule_based" : "ai") as "rule_based" | "ai" }))
    .sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const ai = drafts.find((d) => d.source === "ai" && d.status !== "discarded") ?? drafts.find((d) => d.source === "ai");
  return {
    groupId: root.draft_group_id, kind: root.kind, target: { caseId: root.case_id, referralId: root.referral_id }, drafts,
    selectedDraftId: rows.find((r) => r.selection_status === "selected")?.id ?? null,
    approvedDraftId: rows.find((r) => r.status === "approved")?.id ?? null,
    job,
    comparison: ai ? { ruleDraftId: root.id, aiDraftId: ai.id, result: compareDrafts(root.content, ai.content, ai.content.ai?.sectionEngines) } : null,
  };
}

/** Groups for a case or referral page (caller has checked read access to the target). Newest first. */
export async function listDraftGroups(tx: Db, target: { caseId?: string; referralId?: string }): Promise<DraftGroupView[]> {
  const rows = await tx.query<Row>(
    `SELECT ${COLS} ${FROM} WHERE d.draft_group_id IN (
       SELECT id FROM ai_drafts WHERE ${target.caseId ? "case_id = $1" : "referral_id = $1"} AND id = draft_group_id ORDER BY created_at DESC LIMIT 20)`,
    [target.caseId ?? target.referralId],
  );
  const byGroup = new Map<string, Row[]>();
  for (const r of rows) byGroup.set(r.draft_group_id, [...(byGroup.get(r.draft_group_id) ?? []), r]);
  const out: DraftGroupView[] = [];
  for (const [gid, g] of byGroup) {
    const root = g.find((r) => r.id === gid);
    if (!root) continue;
    out.push(toView(g, await latestJobForDraft(tx, gid, root.status)));
  }
  return out.sort((a, b) => new Date(b.drafts[0].created_at).getTime() - new Date(a.drafts[0].created_at).getTime());
}

async function loadDraft(tx: Db, draftId: string) {
  const [d] = await tx.query<{ id: string; case_id: string | null; referral_id: string | null; kind: string; draft_group_id: string }>(
    `SELECT id, case_id, referral_id, kind, draft_group_id FROM ai_drafts WHERE id = $1`, [draftId]);
  if (!d) throw notFound("초안");
  return d;
}

/** Comparison view of the group a draft belongs to. Read access required; other tenants / no access → 404. */
export async function getDraftGroup(tx: Db, actor: Actor, draftId: string) {
  const d = await loadDraft(tx, draftId);
  await assertDraftRead(tx, actor, d);
  const rows = await tx.query<Row>(`SELECT ${COLS} ${FROM} WHERE d.draft_group_id = $1`, [d.draft_group_id]);
  const root = rows.find((r) => r.id === d.draft_group_id)!;
  const view = toView(rows, await latestJobForDraft(tx, d.draft_group_id, root.status));
  let canReview = true;
  try {
    await assertDraftReview(tx, actor, d, "approve");
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    canReview = false;
  }
  return { ...view, canReview };
}

/** Locks every draft of the group in id order (deterministic → no deadlock between concurrent reviewers). */
export async function lockGroup(tx: Db, groupId: string) {
  return tx.query<{ id: string; status: string; selection_status: string; engine: string }>(
    `SELECT id, status, selection_status, engine FROM ai_drafts WHERE draft_group_id = $1 ORDER BY id FOR UPDATE`, [groupId]);
}

export async function selectDraft(tx: Db, actor: Actor, draftId: string) {
  const d = await loadDraft(tx, draftId);
  await assertDraftReview(tx, actor, d, "approve");
  const group = await lockGroup(tx, d.draft_group_id);
  const me = group.find((g) => g.id === draftId)!;
  if (group.some((g) => g.status === "approved")) throw conflict("이미 승인된 초안이 있어 선택을 바꿀 수 없습니다.");
  if (me.status !== "draft") throw conflict("폐기된 초안은 선택할 수 없습니다.");
  const previous = group.find((g) => g.selection_status === "selected")?.id ?? null;
  if (previous === draftId) return { selectedDraftId: draftId, changed: false };
  await tx.query(`UPDATE ai_drafts SET selection_status = 'set_aside', selected_by = NULL, selected_at = NULL WHERE draft_group_id = $1 AND id <> $2 AND status = 'draft'`, [d.draft_group_id, draftId]);
  await tx.query(`UPDATE ai_drafts SET selection_status = 'selected', selected_by = $2, selected_at = now() WHERE id = $1`, [draftId, actor.id]);
  await audit(tx, actor, "ai.select", { type: "ai_draft", id: draftId }, "success", { group: d.draft_group_id, engine: me.engine, previous });
  return { selectedDraftId: draftId, changed: true };
}

/** "Compare later": no draft is selected, all unreviewed drafts stay candidates. */
export async function holdGroup(tx: Db, actor: Actor, draftId: string) {
  const d = await loadDraft(tx, draftId);
  await assertDraftReview(tx, actor, d, "approve");
  const group = await lockGroup(tx, d.draft_group_id);
  if (group.some((g) => g.status === "approved")) throw conflict("이미 승인된 초안이 있습니다.");
  const previous = group.find((g) => g.selection_status === "selected")?.id ?? null;
  await tx.query(`UPDATE ai_drafts SET selection_status = 'candidate', selected_by = NULL, selected_at = NULL WHERE draft_group_id = $1 AND status = 'draft'`, [d.draft_group_id]);
  await audit(tx, actor, "ai.hold", { type: "ai_draft", id: d.draft_group_id }, "success", { group: d.draft_group_id, previous });
  return { selectedDraftId: null };
}
