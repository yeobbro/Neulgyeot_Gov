import { z } from "zod";
import {
  ANSWER_STATUSES,
  ASSESSMENT_DOMAINS,
  ASSESSMENT_KINDS,
  CASE_STATUSES,
  CASE_TRANSITIONS,
  INTAKE_ROUTES,
  RECORD_TYPES,
  type AssessmentDomain,
  type AssessmentKind,
  type CaseStatus,
} from "../../domain/enums";
import { answerSummary, canConfirmAssessment, validateAssessmentForConfirm } from "../../domain/assessment";
import { STATUS_GROUPS } from "../../domain/metrics";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead, assertCaseWrite, isAdmin, isStaff, regionScopeSql, requireRole } from "../authz";
import type { Db } from "../db/client";
import { newId, nextNo } from "../db/ids";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { addDays, addTask, advanceCaseIfValid, transitionCase } from "./common";

export const caseListQuery = z.object({
  status: z.enum(CASE_STATUSES).optional(),
  route: z.enum(INTAKE_ROUTES).optional(),
  region: z.string().max(40).optional(),
  q: z.string().max(40).optional(),
  filter: z.enum(["overdue", "unlinked", "mine", "monitoring_due", "open"]).optional(),
  group: z.string().max(30).optional(),
  sort: z.enum(["next_action", "updated", "code"]).default("next_action"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function listCases(tx: Db, actor: Actor, q: z.infer<typeof caseListQuery>) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = [regionScopeSql(actor, "c.region_unit_id", params)];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`).replaceAll("§", `$${params.length}`));
  };
  if (q.status) add("c.status = ?", q.status);
  if (q.route) add("c.intake_route = ?", q.route);
  if (q.group && STATUS_GROUPS[q.group]) add("c.status = ANY(?::text[])", STATUS_GROUPS[q.group].statuses);
  if (q.region) add("c.region_unit_id = ?", q.region);
  if (q.q) add("(c.case_code ILIKE ? OR r.display_name ILIKE ? OR r.recipient_code ILIKE ?)".replaceAll("?", "§"), `%${q.q}%`);
  if (q.filter === "overdue") where.push("c.next_action_at < now() AND c.status NOT IN ('CLOSED','WITHDRAWN')");
  if (q.filter === "open") where.push("c.status NOT IN ('CLOSED','WITHDRAWN')");
  if (q.filter === "monitoring_due") where.push("c.status = 'MONITORING_DUE'");
  if (q.filter === "mine") add("EXISTS (SELECT 1 FROM case_assignments a WHERE a.case_id = c.id AND a.user_id = ? AND a.ended_at IS NULL)", actor.id);
  if (q.filter === "unlinked")
    where.push(`c.status IN ('SUPPORT_PLAN_APPROVED','SERVICE_REFERRAL_PENDING','PLAN_REVIEW')
      AND NOT EXISTS (SELECT 1 FROM service_referrals s WHERE s.case_id = c.id AND s.status IN ('ACCEPTED','SCHEDULED','STARTED'))`);
  const w = where.join(" AND ");
  const order = q.sort === "updated" ? "c.updated_at DESC" : q.sort === "code" ? "c.case_code" : "c.next_action_at ASC NULLS LAST, c.case_code";
  const [{ total }] = await tx.query<{ total: number }>(`SELECT count(*)::int AS total FROM care_cases c JOIN care_recipients r ON r.id = c.recipient_id WHERE ${w}`, params);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await tx.query(
    `SELECT c.id, c.case_code, r.display_name, r.age_band, rg.name AS region_name, c.status, c.intake_route, u.display_name AS worker_name,
            c.last_contact_at, c.next_action_at, c.next_action_label, c.updated_at,
            (SELECT count(*)::int FROM action_tasks t WHERE t.case_id = c.id AND t.status = 'open') AS open_tasks
       FROM care_cases c JOIN care_recipients r ON r.id = c.recipient_id JOIN region_units rg ON rg.id = c.region_unit_id
       LEFT JOIN users u ON u.id = c.primary_worker_id
      WHERE ${w} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  await audit(tx, actor, "case.list", { type: "care_case" }, "success", { count: rows.length });
  return { data: rows, total, page: q.page, pageSize: q.pageSize };
}

export async function getCase(tx: Db, actor: Actor, caseId: string) {
  const access = await assertCaseRead(tx, actor, caseId);
  const [c] = await tx.query<Record<string, unknown> & { recipient_id: string; status: CaseStatus }>(
    `SELECT c.*, r.recipient_code, r.display_name, r.age_band, r.household_type, r.is_synthetic, rg.name AS region_name, u.display_name AS worker_name
       FROM care_cases c JOIN care_recipients r ON r.id = c.recipient_id JOIN region_units rg ON rg.id = c.region_unit_id
       LEFT JOIN users u ON u.id = c.primary_worker_id WHERE c.id = $1`,
    [caseId],
  );
  const applications = await tx.query(
    `SELECT a.application_no, a.route, a.applicant_type, a.received_at, a.summary, ir.id AS referral_id, ir.receipt_no
       FROM applications a LEFT JOIN incoming_referrals ir ON ir.id = a.incoming_referral_id WHERE a.case_id = $1 ORDER BY a.received_at`,
    [caseId],
  );
  const assignments = await tx.query(
    `SELECT a.user_id, u.display_name, a.assignment_role, a.assigned_at FROM case_assignments a JOIN users u ON u.id = a.user_id WHERE a.case_id = $1 AND a.ended_at IS NULL`,
    [caseId],
  );
  const tasks = await tx.query(`SELECT id, task_type, title, due_at, status FROM action_tasks WHERE case_id = $1 AND status = 'open' ORDER BY due_at NULLS LAST`, [caseId]);
  await audit(tx, actor, "case.view", { type: "care_case", id: caseId }, "success");
  return { case: c, access, applications, assignments, tasks, allowedTransitions: CASE_TRANSITIONS[c.status] };
}

/** Direct identifiers: only admin or an assigned case manager; every view is audited. */
export async function getIdentity(tx: Db, actor: Actor, caseId: string) {
  const access = await assertCaseRead(tx, actor, caseId);
  if (!isAdmin(actor) && !access.assigned) throw forbidden("배정된 담당자만 식별정보를 열람할 수 있습니다.");
  const [row] = await tx.query(
    `SELECT i.legal_name, i.birth_date, i.contact, i.source_basis FROM recipient_identities i JOIN care_cases c ON c.recipient_id = i.recipient_id WHERE c.id = $1`,
    [caseId],
  );
  await audit(tx, actor, "recipient.identity_view", { type: "care_case", id: caseId }, "success");
  return row ?? null;
}

export const caseTransitionBody = z.object({ to: z.enum(CASE_STATUSES), reason: z.string().trim().max(300).optional() });
export async function changeCaseStatus(tx: Db, actor: Actor, caseId: string, body: z.infer<typeof caseTransitionBody>) {
  await assertCaseWrite(tx, actor, caseId);
  if ((body.to === "CLOSED" || body.to === "WITHDRAWN") && (!body.reason || body.reason.length < 5)) throw invalid("종결·철회 사유를 5자 이상 입력해 주세요.");
  if (body.to === "CLOSED") {
    const [open] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_referrals WHERE case_id = $1 AND status IN ('REQUESTED','ACCEPTED','SCHEDULED','STARTED')`, [caseId]);
    if (open.n > 0) throw conflict("진행 중인 서비스 의뢰가 있어 종결할 수 없습니다. 먼저 의뢰를 완료 또는 취소해 주세요.");
  }
  const r = await transitionCase(tx, actor, caseId, body.to, { closureReason: body.reason });
  if (body.to === "CLOSED" || body.to === "WITHDRAWN") {
    await tx.query(`UPDATE action_tasks SET status = 'canceled' WHERE case_id = $1 AND status = 'open'`, [caseId]);
    await tx.query(`UPDATE care_cases SET next_action_at = NULL, next_action_label = NULL WHERE id = $1`, [caseId]);
  }
  return r;
}

export const caseAssignBody = z.object({ userId: z.string().min(3) });
export async function assignCase(tx: Db, actor: Actor, caseId: string, body: z.infer<typeof caseAssignBody>) {
  requireRole(actor, "municipal_admin");
  const c = await assertCaseRead(tx, actor, caseId);
  const [u] = await tx.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'case_manager' WHERE u.id = $1 AND u.is_active`,
    [body.userId],
  );
  if (!u) throw invalid("배정 가능한 활성 담당자가 아닙니다.");
  await tx.query(`UPDATE case_assignments SET ended_at = now() WHERE case_id = $1 AND assignment_role = 'primary' AND ended_at IS NULL AND user_id <> $2`, [caseId, u.id]);
  await tx.query(
    `INSERT INTO case_assignments (id, tenant_id, case_id, user_id, assignment_role, assigned_by) VALUES ($1,$2,$3,$4,'primary',$5) ON CONFLICT DO NOTHING`,
    [newId("asg"), actor.tenantId, caseId, u.id, actor.id],
  );
  await tx.query(`UPDATE care_cases SET primary_worker_id = $2, updated_at = now() WHERE id = $1`, [caseId, u.id]);
  await audit(tx, actor, "case.assign", { type: "care_case", id: caseId }, "success", { assignee: u.id, region: c.region_unit_id });
  return { assigned: u.id };
}

export const newCaseBody = z.object({
  displayName: z.string().trim().min(2).max(30),
  ageBand: z.string().max(10).optional(),
  regionUnitId: z.string().min(3),
  route: z.enum(["self_application", "agency_referral", "outreach"]),
  applicantType: z.enum(["self", "family", "agency", "official"]),
  summary: z.string().trim().max(500).default(""),
});
export async function createCase(tx: Db, actor: Actor, body: z.infer<typeof newCaseBody>) {
  if (!isStaff(actor)) throw forbidden();
  if (!isAdmin(actor) && !actor.regionScope?.includes(body.regionUnitId)) throw forbidden("담당 권역 밖의 사례는 생성할 수 없습니다.");
  const rid = newId("rcp");
  const cid = newId("case");
  await tx.query(`INSERT INTO care_recipients (id, tenant_id, recipient_code, display_name, age_band, region_unit_id, is_synthetic) VALUES ($1,$2,$3,$4,$5,$6,false)`, [
    rid, actor.tenantId, await nextNo(tx, actor.tenantId, "R"), body.displayName, body.ageBand ?? null, body.regionUnitId,
  ]);
  const code = await nextNo(tx, actor.tenantId, "CASE");
  await tx.query(
    `INSERT INTO care_cases (id, tenant_id, case_code, recipient_id, region_unit_id, status, intake_route, primary_worker_id, next_action_at, next_action_label)
     VALUES ($1,$2,$3,$4,$5,'APPLICATION_RECEIVED',$6,$7,$8,'초기 상담')`,
    [cid, actor.tenantId, code, rid, body.regionUnitId, body.route, isAdmin(actor) ? null : actor.id, addDays(3)],
  );
  if (!isAdmin(actor)) await tx.query(`INSERT INTO case_assignments (id, tenant_id, case_id, user_id, assignment_role, assigned_by) VALUES ($1,$2,$3,$4,'primary',$4)`, [newId("asg"), actor.tenantId, cid, actor.id]);
  await tx.query(`INSERT INTO applications (id, tenant_id, case_id, application_no, route, applicant_type, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    newId("app"), actor.tenantId, cid, await nextNo(tx, actor.tenantId, "APP"), body.route, body.applicantType, body.summary,
  ]);
  await audit(tx, actor, "record.create", { type: "care_case", id: cid }, "success", { route: body.route });
  return { caseId: cid, caseCode: code };
}

/* ------------------------------ records ------------------------------ */
export const recordBody = z.object({ recordType: z.enum(RECORD_TYPES), body: z.string().trim().min(2).max(4000), occurredAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)) });
export const recordEditBody = z.object({ body: z.string().trim().min(2).max(4000), reason: z.string().trim().min(2).max(200), expectedRevision: z.number().int().min(1) });

export async function listRecords(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  return tx.query(
    `SELECT r.id, r.record_type, r.body, r.occurred_at, r.revision, r.author_id, u.display_name AS author_name, r.created_at
       FROM case_records r JOIN users u ON u.id = r.author_id WHERE r.case_id = $1 AND NOT r.is_deleted ORDER BY r.occurred_at DESC`,
    [caseId],
  );
}
export async function createRecord(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof recordBody>) {
  await assertCaseWrite(tx, actor, caseId);
  const id = newId("rec");
  await tx.query(`INSERT INTO case_records (id, tenant_id, case_id, record_type, body, occurred_at, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    id, actor.tenantId, caseId, b.recordType, b.body, new Date(b.occurredAt).toISOString(), actor.id,
  ]);
  if (["consultation", "visit", "phone"].includes(b.recordType)) await tx.query(`UPDATE care_cases SET last_contact_at = GREATEST(coalesce(last_contact_at, 'epoch'), $2), updated_at = now() WHERE id = $1`, [caseId, new Date(b.occurredAt).toISOString()]);
  await audit(tx, actor, "record.create", { type: "case_record", id }, "success", { caseId, recordType: b.recordType });
  return { id };
}
export async function editRecord(tx: Db, actor: Actor, caseId: string, recordId: string, b: z.infer<typeof recordEditBody>) {
  await assertCaseWrite(tx, actor, caseId);
  const [r] = await tx.query<{ body: string; revision: number; author_id: string }>(`SELECT body, revision, author_id FROM case_records WHERE id = $1 AND case_id = $2 AND NOT is_deleted FOR UPDATE`, [recordId, caseId]);
  if (!r) throw notFound("기록");
  if (r.author_id !== actor.id && !isAdmin(actor)) throw forbidden("작성자 또는 관리자만 수정할 수 있습니다.");
  if (r.revision !== b.expectedRevision) throw conflict("다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도해 주세요.");
  await tx.query(`INSERT INTO record_revisions (id, tenant_id, record_id, revision, previous_body, edited_by, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    newId("rrv"), actor.tenantId, recordId, r.revision, r.body, actor.id, b.reason,
  ]);
  await tx.query(`UPDATE case_records SET body = $2, revision = revision + 1 WHERE id = $1`, [recordId, b.body]);
  await audit(tx, actor, "record.update", { type: "case_record", id: recordId }, "success", { revision: r.revision + 1 });
  return { revision: r.revision + 1 };
}
export async function deleteRecord(tx: Db, actor: Actor, caseId: string, recordId: string, reason: string) {
  await assertCaseWrite(tx, actor, caseId);
  if (reason.trim().length < 2) throw invalid("삭제 사유를 입력해 주세요.");
  const [r] = await tx.query<{ body: string; revision: number; author_id: string }>(`SELECT body, revision, author_id FROM case_records WHERE id = $1 AND case_id = $2 AND NOT is_deleted`, [recordId, caseId]);
  if (!r) throw notFound("기록");
  if (r.author_id !== actor.id && !isAdmin(actor)) throw forbidden();
  // Soft delete with revision history (retention policy decides physical deletion).
  await tx.query(`INSERT INTO record_revisions (id, tenant_id, record_id, revision, previous_body, edited_by, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    newId("rrv"), actor.tenantId, recordId, r.revision, r.body, actor.id, `[삭제] ${reason}`,
  ]);
  await tx.query(`UPDATE case_records SET is_deleted = true, revision = revision + 1 WHERE id = $1`, [recordId]);
  await audit(tx, actor, "record.delete", { type: "case_record", id: recordId }, "success");
  return { deleted: true };
}

/* ---------------------------- assessments ---------------------------- */
export async function getAssessment(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  const list = await tx.query<{ id: string; kind: AssessmentKind; status: string; surveyed_at: string | null; confirmed_at: string | null; version: number; surveyor_name: string; confirmer_name: string | null }>(
    `SELECT a.id, a.kind, a.status, a.surveyed_at, a.confirmed_at, a.version, u.display_name AS surveyor_name, cu.display_name AS confirmer_name
       FROM needs_assessments a JOIN users u ON u.id = a.surveyor_id LEFT JOIN users cu ON cu.id = a.confirmed_by
      WHERE a.case_id = $1 ORDER BY a.updated_at DESC`,
    [caseId],
  );
  const current = list[0] ?? null;
  const items = current
    ? await tx.query<{ domain: AssessmentDomain; answer_status: (typeof ANSWER_STATUSES)[number] | null; value: string; note: string }>(
        `SELECT domain, answer_status, value, note FROM assessment_items WHERE assessment_id = $1`,
        [current.id],
      )
    : [];
  const [home] = current ? await tx.query(`SELECT housing_type, barriers, heating_cooling, safety_notes, modification_needed FROM home_environment_assessments WHERE assessment_id = $1`, [current.id]) : [];
  return { assessments: list, current, items, home: home ?? null, summary: answerSummary(items.map((i) => ({ answerStatus: i.answer_status }))) };
}

export const assessmentSaveBody = z.object({
  assessmentId: z.string().optional(),
  kind: z.enum(ASSESSMENT_KINDS).default("municipal_survey"),
  expectedVersion: z.number().int().optional(),
  surveyedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  items: z.array(z.object({ domain: z.enum(ASSESSMENT_DOMAINS), answerStatus: z.enum(ANSWER_STATUSES).nullable(), value: z.string().max(1000), note: z.string().max(500) })).max(ASSESSMENT_DOMAINS.length),
  home: z.object({ housingType: z.string().max(60).nullable(), barriers: z.array(z.string().max(40)).max(10), heatingCooling: z.string().max(60).nullable(), safetyNotes: z.string().max(500), modificationNeeded: z.boolean().nullable() }).optional(),
});

export async function saveAssessment(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof assessmentSaveBody>) {
  await assertCaseWrite(tx, actor, caseId);
  let id = b.assessmentId;
  if (id) {
    const [a] = await tx.query<{ status: string; version: number }>(`SELECT status, version FROM needs_assessments WHERE id = $1 AND case_id = $2 FOR UPDATE`, [id, caseId]);
    if (!a) throw notFound("조사");
    if (a.status === "confirmed") throw conflict("확정된 조사는 수정할 수 없습니다. 재조사를 새로 작성해 주세요.");
    if (b.expectedVersion !== undefined && a.version !== b.expectedVersion) throw conflict("다른 사용자가 먼저 저장했습니다. 새로고침 후 다시 시도해 주세요.");
    await tx.query(`UPDATE needs_assessments SET version = version + 1, surveyed_at = COALESCE($2, surveyed_at), status = 'draft', updated_at = now() WHERE id = $1`, [id, b.surveyedAt ?? null]);
  } else {
    id = newId("asm");
    await tx.query(`INSERT INTO needs_assessments (id, tenant_id, case_id, kind, status, surveyed_at, surveyor_id) VALUES ($1,$2,$3,$4,'draft',$5,$6)`, [
      id, actor.tenantId, caseId, b.kind, b.surveyedAt ?? null, actor.id,
    ]);
  }
  for (const it of b.items) {
    await tx.query(
      `INSERT INTO assessment_items (id, tenant_id, assessment_id, domain, answer_status, value, note) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (assessment_id, domain) DO UPDATE SET answer_status = EXCLUDED.answer_status, value = EXCLUDED.value, note = EXCLUDED.note`,
      [newId("ai"), actor.tenantId, id, it.domain, it.answerStatus, it.value, it.note],
    );
  }
  if (b.home) {
    await tx.query(
      `INSERT INTO home_environment_assessments (assessment_id, tenant_id, housing_type, barriers, heating_cooling, safety_notes, modification_needed) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (assessment_id) DO UPDATE SET housing_type = EXCLUDED.housing_type, barriers = EXCLUDED.barriers, heating_cooling = EXCLUDED.heating_cooling, safety_notes = EXCLUDED.safety_notes, modification_needed = EXCLUDED.modification_needed`,
      [id, actor.tenantId, b.home.housingType, b.home.barriers, b.home.heatingCooling, b.home.safetyNotes, b.home.modificationNeeded],
    );
  }
  await advanceCaseIfValid(tx, actor, caseId, "SURVEY_IN_PROGRESS");
  await audit(tx, actor, "assessment.save", { type: "needs_assessment", id }, "success", { items: b.items.length });
  const [v] = await tx.query<{ version: number }>(`SELECT version FROM needs_assessments WHERE id = $1`, [id]);
  return { assessmentId: id, version: v.version };
}

export async function submitAssessment(tx: Db, actor: Actor, caseId: string, assessmentId: string) {
  await assertCaseWrite(tx, actor, caseId);
  const items = await tx.query<{ domain: AssessmentDomain; answer_status: (typeof ANSWER_STATUSES)[number] | null; value: string; note: string }>(
    `SELECT i.domain, i.answer_status, i.value, i.note FROM assessment_items i JOIN needs_assessments a ON a.id = i.assessment_id WHERE a.id = $1 AND a.case_id = $2`,
    [assessmentId, caseId],
  );
  const issues = validateAssessmentForConfirm(items.map((i) => ({ domain: i.domain, answerStatus: i.answer_status, value: i.value, note: i.note })));
  if (issues.length) throw invalid("확인되지 않은 조사 항목이 있습니다.", { issues });
  const rows = await tx.query(`UPDATE needs_assessments SET status = 'submitted', updated_at = now() WHERE id = $1 AND case_id = $2 AND status = 'draft' RETURNING id`, [assessmentId, caseId]);
  if (!rows.length) throw conflict("작성 중인 조사만 검토 요청할 수 있습니다.");
  await advanceCaseIfValid(tx, actor, caseId, "ASSESSMENT_REVIEW");
  await audit(tx, actor, "assessment.save", { type: "needs_assessment", id: assessmentId }, "success", { submitted: true });
  return { status: "submitted" };
}

/** Confirmation is a reviewer step: admin (or ABAC-authorised staff for the official determination). */
export async function confirmAssessment(tx: Db, actor: Actor, caseId: string, assessmentId: string) {
  const access = await assertCaseRead(tx, actor, caseId);
  const [a] = await tx.query<{ kind: AssessmentKind; status: string; surveyor_id: string }>(`SELECT kind, status, surveyor_id FROM needs_assessments WHERE id = $1 AND case_id = $2 FOR UPDATE`, [assessmentId, caseId]);
  if (!a) throw notFound("조사");
  if (a.status !== "submitted") throw conflict("검토 요청된 조사만 확정할 수 있습니다.");
  const allowed = canConfirmAssessment(a.kind, { canConfirmOfficialDetermination: actor.canConfirmOfficialDetermination, isAdmin: isAdmin(actor), isAssigned: access.assigned });
  if (!allowed) throw forbidden(a.kind === "official_determination" ? "제도상 통합판정 확정 권한이 없습니다." : "조사 확정 권한이 없습니다.");
  await tx.query(`UPDATE needs_assessments SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), updated_at = now() WHERE id = $1`, [assessmentId, actor.id]);
  await advanceCaseIfValid(tx, actor, caseId, "ASSESSMENT_COMPLETED");
  await addTask(tx, actor.tenantId, { caseId, type: "service_change", title: "평가 확정 — 개인별 지원계획 작성", dueAt: addDays(7) });
  await audit(tx, actor, "assessment.confirm", { type: "needs_assessment", id: assessmentId }, "success", { kind: a.kind });
  return { status: "confirmed" };
}
