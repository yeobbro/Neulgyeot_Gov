import { z } from "zod";
import { MONITORING_METHODS } from "../../domain/enums";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead, assertCaseWrite, isAdmin, isStaff, regionScopeSql } from "../authz";
import type { Db } from "../db/client";
import { newId } from "../db/ids";
import { forbidden, invalid, notFound } from "../errors";
import { addDays, addTask, advanceCaseIfValid } from "./common";

export const monitoringBody = z.object({
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
  method: z.enum(MONITORING_METHODS),
  serviceUsed: z.enum(["yes", "partial", "no", "unknown"]),
  satisfaction: z.enum(["satisfied", "neutral", "dissatisfied", "no_response"]).nullable(),
  statusChange: z.string().trim().max(1000).default(""),
  nonDeliveryReason: z.string().trim().max(500).nullable().optional(),
  additionalNeeds: z.string().trim().max(1000).default(""),
  planChangeNeeded: z.boolean(),
  nextDueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  opinion: z.string().trim().max(1000).default(""),
  followUps: z.array(z.enum(["visit_planned", "contact_needed", "service_not_delivered", "service_change", "provider_change", "closure_review"])).max(6).default([]),
});

export async function listMonitoring(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  return tx.query(
    `SELECT m.*, u.display_name AS recorder_name FROM monitoring_records m JOIN users u ON u.id = m.recorded_by WHERE m.case_id = $1 ORDER BY m.checked_at DESC`,
    [caseId],
  );
}

const FOLLOW_UP_TITLE: Record<string, string> = {
  visit_planned: "방문 예정",
  contact_needed: "연락 필요",
  service_not_delivered: "서비스 미수행 확인",
  service_change: "서비스 변경 검토",
  provider_change: "기관 변경 검토",
  closure_review: "사례 종결 검토",
};

export async function createMonitoring(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof monitoringBody>) {
  await assertCaseWrite(tx, actor, caseId);
  if ((b.serviceUsed === "no" || b.serviceUsed === "partial") && (!b.nonDeliveryReason || b.nonDeliveryReason.length < 2)) throw invalid("서비스 미수행·부분 수행 사유를 입력해 주세요.");
  const [s] = await tx.query<{ monitoring_interval_days: number }>(`SELECT monitoring_interval_days FROM tenant_settings WHERE tenant_id = $1`, [actor.tenantId]);
  const next = b.nextDueAt ?? addDays(s?.monitoring_interval_days ?? 30);
  const id = newId("mon");
  await tx.query(
    `INSERT INTO monitoring_records (id, tenant_id, case_id, checked_at, method, service_used, satisfaction, status_change, non_delivery_reason, additional_needs, plan_change_needed, next_due_at, opinion, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, actor.tenantId, caseId, new Date(b.checkedAt).toISOString(), b.method, b.serviceUsed, b.satisfaction, b.statusChange, b.nonDeliveryReason ?? null, b.additionalNeeds, b.planChangeNeeded, next, b.opinion, actor.id],
  );
  await tx.query(`UPDATE action_tasks SET status = 'done', completed_at = now() WHERE case_id = $1 AND task_type = 'monitoring_due' AND status = 'open'`, [caseId]);
  await tx.query(`UPDATE care_cases SET last_contact_at = $2, next_action_at = $3, next_action_label = '정기 모니터링', updated_at = now() WHERE id = $1`, [caseId, new Date(b.checkedAt).toISOString(), next]);
  const [c] = await tx.query<{ primary_worker_id: string | null }>(`SELECT primary_worker_id FROM care_cases WHERE id = $1`, [caseId]);
  for (const f of b.followUps) await addTask(tx, actor.tenantId, { caseId, type: f, title: FOLLOW_UP_TITLE[f], dueAt: addDays(7), assigneeId: c?.primary_worker_id });
  await addTask(tx, actor.tenantId, { caseId, type: "monitoring_due", title: "다음 정기 모니터링", dueAt: next, assigneeId: c?.primary_worker_id });
  if (b.planChangeNeeded) {
    await tx.query(`UPDATE support_plans SET status = 'CHANGE_REVIEW', version = version + 1 WHERE case_id = $1 AND status IN ('APPROVED','REFERRING','IN_PROGRESS')`, [caseId]);
    await advanceCaseIfValid(tx, actor, caseId, "PLAN_REVIEW");
  } else {
    await advanceCaseIfValid(tx, actor, caseId, "SERVICE_ACTIVE");
  }
  await audit(tx, actor, "monitoring.create", { type: "monitoring_record", id }, "success", { planChangeNeeded: b.planChangeNeeded, followUps: b.followUps.length });
  return { id, nextDueAt: next };
}

/** Rolls cases whose monitoring date has passed into MONITORING_DUE (idempotent; run on dashboard load or by cron). */
export async function refreshMonitoringDue(tx: Db, actor: Actor) {
  const due = await tx.query<{ id: string }>(`SELECT id FROM care_cases WHERE status = 'SERVICE_ACTIVE' AND next_action_at < now()`);
  for (const c of due) await advanceCaseIfValid(tx, actor, c.id, "MONITORING_DUE");
  return due.length;
}

export const taskListQuery = z.object({ scope: z.enum(["mine", "all"]).default("mine"), overdue: z.enum(["1", "0"]).optional() });

export async function listTasks(tx: Db, actor: Actor, q: z.infer<typeof taskListQuery>) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = ["t.status = 'open'", `(t.case_id IS NULL OR ${regionScopeSql(actor, "c.region_unit_id", params)})`];
  if (q.scope === "mine" || !isAdmin(actor)) {
    params.push(actor.id);
    where.push(`(t.assignee_id = $${params.length}${isAdmin(actor) ? " OR t.assignee_id IS NULL" : ""})`);
  }
  if (q.overdue === "1") where.push("t.due_at < current_date");
  return tx.query(
    `SELECT t.id, t.task_type, t.title, t.due_at, t.status, t.case_id, c.case_code, t.referral_id, ir.receipt_no, u.display_name AS assignee_name
       FROM action_tasks t LEFT JOIN care_cases c ON c.id = t.case_id LEFT JOIN incoming_referrals ir ON ir.id = t.referral_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${where.join(" AND ")} ORDER BY t.due_at NULLS LAST, t.created_at LIMIT 300`,
    params,
  );
}

export async function completeTask(tx: Db, actor: Actor, taskId: string, status: "done" | "canceled") {
  const [t] = await tx.query<{ case_id: string | null; assignee_id: string | null }>(`SELECT case_id, assignee_id FROM action_tasks WHERE id = $1 AND status = 'open'`, [taskId]);
  if (!t) throw notFound("업무");
  if (t.case_id) await assertCaseWrite(tx, actor, t.case_id);
  else if (!isAdmin(actor) && t.assignee_id !== actor.id) throw forbidden();
  await tx.query(`UPDATE action_tasks SET status = $2, completed_at = now() WHERE id = $1`, [taskId, status]);
  await audit(tx, actor, "task.update", { type: "action_task", id: taskId }, "success", { status });
  return { ok: true };
}

export async function listNotifications(tx: Db, actor: Actor) {
  return tx.query(`SELECT id, kind, title, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [actor.id]);
}

export async function caseTimeline(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  const rows = await tx.query<{ at: string; kind: string; title: string; detail: string | null }>(
    `SELECT occurred_at AS at, 'record' AS kind, record_type AS title, NULL AS detail FROM case_records WHERE case_id = $1 AND NOT is_deleted
     UNION ALL SELECT checked_at, 'monitoring', method, CASE WHEN plan_change_needed THEN '지원계획 변경 필요' ELSE NULL END FROM monitoring_records WHERE case_id = $1
     UNION ALL SELECT e.at, 'service', e.to_status, s.referral_no FROM service_delivery_events e JOIN service_referrals s ON s.id = e.service_referral_id WHERE s.case_id = $1
     UNION ALL SELECT updated_at, 'plan', status, 'v' || version_no FROM support_plans WHERE case_id = $1
     UNION ALL SELECT scheduled_at, 'meeting', status, NULL FROM integrated_support_meetings WHERE case_id = $1
     UNION ALL SELECT coalesce(confirmed_at, updated_at), 'assessment', status, kind FROM needs_assessments WHERE case_id = $1
     UNION ALL SELECT a.at, 'status', a.meta->>'to', a.meta->>'from' FROM audit_logs a WHERE a.entity_id = $1 AND a.action IN ('case.status_change','case.close')
     ORDER BY 1 DESC LIMIT 200`,
    [caseId],
  );
  return rows;
}
