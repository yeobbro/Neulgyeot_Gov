import { CASE_TRANSITIONS, canTransition, type CaseStatus, type TaskType } from "../../domain/enums";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { newId } from "../db/ids";
import { badTransition, notFound } from "../errors";

/** Strict, user-requested case transition (validated by the state machine). */
export async function transitionCase(tx: Db, actor: Actor, caseId: string, to: CaseStatus, extra: { closureReason?: string } = {}) {
  const [c] = await tx.query<{ status: CaseStatus }>(`SELECT status FROM care_cases WHERE id = $1 FOR UPDATE`, [caseId]);
  if (!c) throw notFound("사례");
  if (!canTransition(CASE_TRANSITIONS, c.status, to)) throw badTransition(c.status, to);
  const closing = to === "CLOSED" || to === "WITHDRAWN";
  await tx.query(
    `UPDATE care_cases SET status = $2, closed_at = CASE WHEN $3 THEN now() ELSE closed_at END,
        closure_reason = COALESCE($4, closure_reason), version = version + 1, updated_at = now() WHERE id = $1`,
    [caseId, to, closing, extra.closureReason ?? null],
  );
  await audit(tx, actor, closing ? "case.close" : "case.status_change", { type: "case", id: caseId }, "success", { from: c.status, to });
  return { from: c.status, to };
}

/**
 * Workflow side effect: advance the case only if the move is a valid
 * transition from its current status; otherwise leave it unchanged.
 */
export async function advanceCaseIfValid(tx: Db, actor: Actor, caseId: string, to: CaseStatus) {
  const [c] = await tx.query<{ status: CaseStatus }>(`SELECT status FROM care_cases WHERE id = $1`, [caseId]);
  if (!c || c.status === to || !canTransition(CASE_TRANSITIONS, c.status, to)) return false;
  await tx.query(`UPDATE care_cases SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`, [caseId, to]);
  await audit(tx, actor, "case.status_change", { type: "case", id: caseId }, "success", { from: c.status, to, automatic: true });
  return true;
}

export async function addTask(
  tx: Db,
  tenantId: string,
  t: { caseId?: string | null; referralId?: string | null; type: TaskType; title: string; dueAt?: string | null; assigneeId?: string | null },
) {
  const id = newId("tsk");
  await tx.query(
    `INSERT INTO action_tasks (id, tenant_id, case_id, referral_id, task_type, title, due_at, assignee_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, tenantId, t.caseId ?? null, t.referralId ?? null, t.type, t.title, t.dueAt ?? null, t.assigneeId ?? null],
  );
  return id;
}

export async function notify(tx: Db, tenantId: string, userId: string | null | undefined, kind: string, title: string, link: string | null) {
  if (!userId) return;
  await tx.query(`INSERT INTO notifications (id, tenant_id, user_id, kind, title, link) VALUES ($1,$2,$3,$4,$5,$6)`, [
    newId("ntf"), tenantId, userId, kind, title, link,
  ]);
}

export const dateOnly = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
export const addDays = (days: number, base = new Date()) => new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
