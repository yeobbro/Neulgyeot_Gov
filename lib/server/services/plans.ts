import { z } from "zod";
import { PLAN_STATUSES, PLAN_TRANSITIONS, SERVICE_TYPES, canTransition, type PlanStatus } from "../../domain/enums";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead, assertCaseWrite, canApprovePlan, isStaff, regionScopeSql } from "../authz";
import type { Db } from "../db/client";
import { newId } from "../db/ids";
import { badTransition, conflict, forbidden, invalid, notFound } from "../errors";
import { addDays, addTask, advanceCaseIfValid } from "./common";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function getPlans(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  const plans = await tx.query<Record<string, unknown> & { id: string; status: PlanStatus }>(
    `SELECT p.*, u.display_name AS owner_name, au.display_name AS approver_name
       FROM support_plans p JOIN users u ON u.id = p.owner_id LEFT JOIN users au ON au.id = p.approved_by
      WHERE p.case_id = $1 ORDER BY p.version_no DESC`,
    [caseId],
  );
  const current = plans[0] ?? null;
  const items = current
    ? await tx.query(
        `SELECT i.*, sp.name AS provider_name,
                (SELECT s.status FROM service_referrals s WHERE s.plan_item_id = i.id ORDER BY s.updated_at DESC LIMIT 1) AS referral_status,
                (SELECT s.id FROM service_referrals s WHERE s.plan_item_id = i.id ORDER BY s.updated_at DESC LIMIT 1) AS referral_id
           FROM support_plan_items i LEFT JOIN service_providers sp ON sp.id = i.provider_id WHERE i.plan_id = $1 ORDER BY i.id`,
        [current.id],
      )
    : [];
  const meetings = await tx.query(
    `SELECT m.*, (SELECT json_agg(json_build_object('organization', p.organization_name, 'role', p.participant_role, 'attended', p.attended) ORDER BY p.id) FROM meeting_participants p WHERE p.meeting_id = m.id) AS participants,
            (SELECT json_agg(json_build_object('decision', d.decision, 'content', d.content, 'decided_at', d.decided_at, 'decided_by', du.display_name) ORDER BY d.decided_at) FROM meeting_decisions d JOIN users du ON du.id = d.decided_by WHERE d.meeting_id = m.id) AS decisions
       FROM integrated_support_meetings m WHERE m.case_id = $1 ORDER BY m.scheduled_at DESC`,
    [caseId],
  );
  return { plans, current, items, meetings, allowedTransitions: current ? PLAN_TRANSITIONS[current.status] : [], canApprove: await canApprovePlan(tx, actor) };
}

export const planSaveBody = z.object({
  planId: z.string().optional(),
  expectedVersion: z.number().int().optional(),
  goals: z.string().trim().min(5).max(1000),
  mainNeeds: z.string().trim().min(2).max(1000),
  recipientWishes: z.string().trim().max(1000).default(""),
  additionalChecks: z.string().trim().max(1000).default(""),
  startDate: dateStr.nullable().optional(),
  reviewDate: dateStr.nullable().optional(),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        serviceType: z.enum(SERVICE_TYPES),
        department: z.string().trim().min(2).max(60),
        providerId: z.string().nullable().optional(),
        frequency: z.string().trim().min(1).max(60),
        startDate: dateStr.nullable().optional(),
        endDate: dateStr.nullable().optional(),
        method: z.string().trim().max(200).default(""),
        notes: z.string().trim().max(300).default(""),
      }),
    )
    .min(1, "지원 서비스 항목을 1개 이상 입력해 주세요.")
    .max(15),
});

export async function savePlan(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof planSaveBody>) {
  await assertCaseWrite(tx, actor, caseId);
  for (const it of b.items) if (it.startDate && it.endDate && it.endDate < it.startDate) throw invalid("종료일이 시작일보다 빠릅니다.");
  if (b.startDate && b.reviewDate && b.reviewDate < b.startDate) throw invalid("재검토 예정일이 시작일보다 빠릅니다.");
  let planId = b.planId;
  if (planId) {
    const [p] = await tx.query<{ status: PlanStatus; version: number }>(`SELECT status, version FROM support_plans WHERE id = $1 AND case_id = $2 FOR UPDATE`, [planId, caseId]);
    if (!p) throw notFound("지원계획");
    if (!["DRAFT", "NEEDS_REVISION"].includes(p.status)) throw conflict("작성 중 또는 보완 필요 상태의 계획만 수정할 수 있습니다.");
    if (b.expectedVersion !== undefined && b.expectedVersion !== p.version) throw conflict("다른 사용자가 먼저 저장했습니다. 새로고침 후 다시 시도해 주세요.");
    await tx.query(
      `UPDATE support_plans SET goals=$2, main_needs=$3, recipient_wishes=$4, additional_checks=$5, start_date=$6, review_date=$7, status='DRAFT', version=version+1, updated_at=now() WHERE id=$1`,
      [planId, b.goals, b.mainNeeds, b.recipientWishes, b.additionalChecks, b.startDate ?? null, b.reviewDate ?? null],
    );
    const used = await tx.query<{ plan_item_id: string }>(`SELECT DISTINCT plan_item_id FROM service_referrals WHERE plan_item_id IN (SELECT id FROM support_plan_items WHERE plan_id = $1)`, [planId]);
    const keep = new Set([...b.items.map((i) => i.id).filter(Boolean), ...used.map((u) => u.plan_item_id)]);
    await tx.query(`DELETE FROM support_plan_items WHERE plan_id = $1 AND NOT (id = ANY($2::text[]))`, [planId, [...keep]]);
  } else {
    const [{ n }] = await tx.query<{ n: number }>(`SELECT coalesce(max(version_no),0)::int AS n FROM support_plans WHERE case_id = $1`, [caseId]);
    const [open] = await tx.query<{ status: PlanStatus }>(`SELECT status FROM support_plans WHERE case_id = $1 ORDER BY version_no DESC LIMIT 1`, [caseId]);
    if (open && !["CLOSED", "CHANGE_REVIEW"].includes(open.status)) throw conflict("진행 중인 지원계획이 있습니다. 변경 검토 상태에서만 새 버전을 만들 수 있습니다.");
    planId = newId("pln");
    await tx.query(
      `INSERT INTO support_plans (id, tenant_id, case_id, version_no, status, goals, main_needs, recipient_wishes, additional_checks, start_date, review_date, owner_id)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11)`,
      [planId, actor.tenantId, caseId, n + 1, b.goals, b.mainNeeds, b.recipientWishes, b.additionalChecks, b.startDate ?? null, b.reviewDate ?? null, actor.id],
    );
  }
  for (const it of b.items) {
    const id = it.id ?? newId("pli");
    await tx.query(
      `INSERT INTO support_plan_items (id, tenant_id, plan_id, service_type, department, provider_id, frequency, start_date, end_date, method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET service_type=EXCLUDED.service_type, department=EXCLUDED.department, provider_id=EXCLUDED.provider_id, frequency=EXCLUDED.frequency,
         start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, method=EXCLUDED.method, notes=EXCLUDED.notes`,
      [id, actor.tenantId, planId, it.serviceType, it.department, it.providerId ?? null, it.frequency, it.startDate ?? null, it.endDate ?? null, it.method, it.notes],
    );
  }
  await advanceCaseIfValid(tx, actor, caseId, "SUPPORT_PLAN_DRAFT");
  await audit(tx, actor, "plan.save", { type: "support_plan", id: planId }, "success", { items: b.items.length });
  const [v] = await tx.query<{ version: number }>(`SELECT version FROM support_plans WHERE id = $1`, [planId]);
  return { planId, version: v.version };
}

export const planTransitionBody = z.object({ to: z.enum(PLAN_STATUSES), note: z.string().trim().max(500).optional(), approvalBasis: z.string().trim().max(300).optional() });

export async function transitionPlan(tx: Db, actor: Actor, caseId: string, planId: string, b: z.infer<typeof planTransitionBody>) {
  const access = await assertCaseRead(tx, actor, caseId);
  const [p] = await tx.query<{ status: PlanStatus }>(`SELECT status FROM support_plans WHERE id = $1 AND case_id = $2 FOR UPDATE`, [planId, caseId]);
  if (!p) throw notFound("지원계획");
  if (!canTransition(PLAN_TRANSITIONS, p.status, b.to)) throw badTransition(p.status, b.to);
  if (b.to === "APPROVED") {
    if (!(await canApprovePlan(tx, actor))) throw forbidden("지원계획 승인 권한이 없습니다. (지자체 승인 정책)");
    if (!b.approvalBasis || b.approvalBasis.length < 5) throw invalid("승인 근거(회의 결정 또는 검토 의견)를 입력해 주세요.");
    if (p.status === "MEETING_SCHEDULED") {
      const [d] = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM meeting_decisions d JOIN integrated_support_meetings m ON m.id = d.meeting_id WHERE m.plan_id = $1 AND d.decision = 'approve_plan'`,
        [planId],
      );
      if (d.n === 0) throw conflict("통합지원회의 결과(승인 결정)가 기록되지 않았습니다. 회의 결과를 먼저 기록해 주세요.");
    }
  } else if (!access.assigned && !(await canApprovePlan(tx, actor))) {
    throw forbidden("배정된 담당자 또는 승인권자만 계획 상태를 변경할 수 있습니다.");
  }
  if (b.to === "NEEDS_REVISION" && (!b.note || b.note.length < 5)) throw invalid("보완 필요 사유를 입력해 주세요.");
  await tx.query(
    `UPDATE support_plans SET status = $2, approved_by = CASE WHEN $2 = 'APPROVED' THEN $3 ELSE approved_by END,
        approved_at = CASE WHEN $2 = 'APPROVED' THEN now() ELSE approved_at END, approval_basis = COALESCE($4, approval_basis), version = version + 1, updated_at = now() WHERE id = $1`,
    [planId, b.to, actor.id, b.to === "APPROVED" ? b.approvalBasis : null],
  );
  if (b.to === "APPROVED") await advanceCaseIfValid(tx, actor, caseId, "SUPPORT_PLAN_APPROVED");
  if (b.to === "CHANGE_REVIEW") await advanceCaseIfValid(tx, actor, caseId, "PLAN_REVIEW");
  if (b.to === "DRAFT") await advanceCaseIfValid(tx, actor, caseId, "SUPPORT_PLAN_DRAFT");
  await audit(tx, actor, b.to === "APPROVED" ? "plan.approve" : "plan.status_change", { type: "support_plan", id: planId }, "success", { from: p.status, to: b.to });
  return { from: p.status, to: b.to };
}

/* ------------------------------ meetings ------------------------------ */
export const meetingCreateBody = z.object({
  planId: z.string().min(3),
  scheduledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
  agenda: z.string().trim().min(5).max(1000),
  participants: z.array(z.object({ organization: z.string().trim().min(2).max(80), role: z.string().trim().min(1).max(40) })).min(1).max(20),
});

export async function createMeeting(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof meetingCreateBody>) {
  await assertCaseWrite(tx, actor, caseId);
  const [p] = await tx.query<{ status: PlanStatus }>(`SELECT status FROM support_plans WHERE id = $1 AND case_id = $2 FOR UPDATE`, [b.planId, caseId]);
  if (!p) throw notFound("지원계획");
  if (!canTransition(PLAN_TRANSITIONS, p.status, "MEETING_SCHEDULED")) throw conflict("검토 요청 상태의 지원계획만 통합지원회의에 상정할 수 있습니다.");
  const id = newId("mtg");
  await tx.query(
    `INSERT INTO integrated_support_meetings (id, tenant_id, case_id, plan_id, scheduled_at, status, agenda, created_by) VALUES ($1,$2,$3,$4,$5,'scheduled',$6,$7)`,
    [id, actor.tenantId, caseId, b.planId, new Date(b.scheduledAt).toISOString(), b.agenda, actor.id],
  );
  for (const pt of b.participants) {
    await tx.query(`INSERT INTO meeting_participants (id, tenant_id, meeting_id, organization_name, participant_role) VALUES ($1,$2,$3,$4,$5)`, [newId("mp"), actor.tenantId, id, pt.organization, pt.role]);
  }
  await tx.query(`UPDATE support_plans SET status = 'MEETING_SCHEDULED', version = version + 1, updated_at = now() WHERE id = $1`, [b.planId]);
  await advanceCaseIfValid(tx, actor, caseId, "MEETING_SCHEDULED");
  await audit(tx, actor, "meeting.create", { type: "meeting", id }, "success", { participants: b.participants.length });
  return { meetingId: id };
}

export const meetingRecordBody = z.object({
  confirmedFacts: z.string().trim().min(5).max(2000),
  openQuestions: z.string().trim().max(2000).default(""),
  outcome: z.string().trim().min(5).max(2000),
  decision: z.enum(["approve_plan", "revise_plan", "defer"]),
  decisionContent: z.string().trim().min(5).max(1000),
  attendance: z.array(z.boolean()).optional(),
});

/** Records the meeting result. Plan approval itself is a separate, permission-checked step. */
export async function recordMeeting(tx: Db, actor: Actor, caseId: string, meetingId: string, b: z.infer<typeof meetingRecordBody>) {
  await assertCaseWrite(tx, actor, caseId);
  const [m] = await tx.query<{ status: string; plan_id: string }>(`SELECT status, plan_id FROM integrated_support_meetings WHERE id = $1 AND case_id = $2 FOR UPDATE`, [meetingId, caseId]);
  if (!m) throw notFound("회의");
  if (m.status !== "scheduled") throw conflict("이미 결과가 기록되었거나 취소된 회의입니다.");
  await tx.query(
    `UPDATE integrated_support_meetings SET status = 'held', confirmed_facts = $2, open_questions = $3, outcome = $4, recorded_by = $5, recorded_at = now() WHERE id = $1`,
    [meetingId, b.confirmedFacts, b.openQuestions, b.outcome, actor.id],
  );
  if (b.attendance) {
    const ps = await tx.query<{ id: string }>(`SELECT id FROM meeting_participants WHERE meeting_id = $1 ORDER BY id`, [meetingId]);
    for (const [i, p] of ps.entries()) if (b.attendance[i] !== undefined) await tx.query(`UPDATE meeting_participants SET attended = $2 WHERE id = $1`, [p.id, b.attendance[i]]);
  }
  await tx.query(`INSERT INTO meeting_decisions (id, tenant_id, meeting_id, decision, content, decided_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
    newId("md"), actor.tenantId, meetingId, b.decision, b.decisionContent, actor.id,
  ]);
  if (b.decision === "revise_plan") {
    await tx.query(`UPDATE support_plans SET status = 'NEEDS_REVISION', version = version + 1, updated_at = now() WHERE id = $1 AND status = 'MEETING_SCHEDULED'`, [m.plan_id]);
    await advanceCaseIfValid(tx, actor, caseId, "SUPPORT_PLAN_DRAFT");
  }
  if (b.decision === "approve_plan") {
    await addTask(tx, actor.tenantId, { caseId, type: "service_change", title: "회의 결정 반영 — 지원계획 승인 처리", dueAt: addDays(2) });
  }
  await audit(tx, actor, "meeting.record", { type: "meeting", id: meetingId }, "success", { decision: b.decision });
  return { status: "held" };
}

/** Tenant-wide lists for the plans/meetings pages (region-scoped). */
export async function listPlansOverview(tx: Db, actor: Actor) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const w = regionScopeSql(actor, "c.region_unit_id", params);
  const plans = await tx.query(
    `SELECT p.id, p.status, p.version_no, p.review_date, p.updated_at, c.id AS case_id, c.case_code, r.display_name, u.display_name AS owner_name,
            (SELECT count(*)::int FROM support_plan_items i WHERE i.plan_id = p.id) AS item_count
       FROM support_plans p JOIN care_cases c ON c.id = p.case_id JOIN care_recipients r ON r.id = c.recipient_id JOIN users u ON u.id = p.owner_id
      WHERE ${w} ORDER BY p.updated_at DESC LIMIT 200`,
    params,
  );
  const meetings = await tx.query(
    `SELECT m.id, m.scheduled_at, m.status, m.agenda, c.id AS case_id, c.case_code, r.display_name
       FROM integrated_support_meetings m JOIN care_cases c ON c.id = m.case_id JOIN care_recipients r ON r.id = c.recipient_id
      WHERE ${w} ORDER BY m.scheduled_at DESC LIMIT 200`,
    params,
  );
  return { plans, meetings };
}
