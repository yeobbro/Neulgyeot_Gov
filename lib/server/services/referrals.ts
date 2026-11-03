import { z } from "zod";
import { CATEGORY_LABEL, HOSPITAL_SERVICE_TO_TYPE, type TransferCategory } from "../../integrations/hospital/schema";
import { REFERRAL_STATUSES, REFERRAL_TRANSITIONS, canTransition, type ReferralStatus } from "../../domain/enums";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { isAdmin, isStaff, regionScopeSql, requireRole } from "../authz";
import type { Db } from "../db/client";
import { newId, nextNo } from "../db/ids";
import { badTransition, forbidden, invalid, notFound } from "../errors";
import { addDays, addTask, notify } from "./common";
import { queueOutboundStatus } from "./integration";

export const referralListQuery = z.object({
  status: z.enum(REFERRAL_STATUSES).optional(),
  q: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Visibility: admins see all referrals in the tenant. Case managers see
 * referrals routed to their region scope or assigned to them; unrouted new
 * referrals are visible only to admins (who triage and assign).
 */
function scopeWhere(actor: Actor, params: unknown[]) {
  if (isAdmin(actor)) return "TRUE";
  params.push(actor.id);
  const me = `$${params.length}`;
  return `(${regionScopeSql(actor, "r.region_unit_id", params)} OR r.assigned_user_id = ${me})`;
}

export async function listReferrals(tx: Db, actor: Actor, q: z.infer<typeof referralListQuery>) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = [scopeWhere(actor, params)];
  if (q.status) {
    params.push(q.status);
    where.push(`r.status = $${params.length}`);
  }
  if (q.q) {
    params.push(`%${q.q}%`);
    where.push(`(r.receipt_no ILIKE $${params.length} OR r.subject_ref ILIKE $${params.length} OR r.source_org_name ILIKE $${params.length})`);
  }
  const w = where.join(" AND ");
  const [{ total }] = await tx.query<{ total: number }>(`SELECT count(*)::int AS total FROM incoming_referrals r WHERE ${w}`, params);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await tx.query(
    `SELECT r.id, r.receipt_no, r.transfer_id, r.source_org_name, r.received_at, r.discharge_date, r.subject_ref, r.subject_display, r.requested_services,
            r.status, r.consent_check_status, r.missing_items, rg.name AS region_name, u.display_name AS assignee_name
       FROM incoming_referrals r LEFT JOIN region_units rg ON rg.id = r.region_unit_id LEFT JOIN users u ON u.id = r.assigned_user_id
      WHERE ${w} ORDER BY r.received_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const cp: unknown[] = [];
  const counts = await tx.query<{ status: ReferralStatus; n: number }>(
    `SELECT r.status, count(*)::int AS n FROM incoming_referrals r WHERE ${scopeWhere(actor, cp)} GROUP BY r.status`,
    cp,
  );
  await audit(tx, actor, "case.list", { type: "incoming_referral" }, "success", { count: rows.length });
  return { data: rows, total, page: q.page, pageSize: q.pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

async function loadScoped(tx: Db, actor: Actor, id: string) {
  if (!isStaff(actor)) throw notFound("연계 신청");
  const params: unknown[] = [id];
  const [r] = await tx.query<Record<string, unknown> & { id: string; status: ReferralStatus; region_unit_id: string | null; assigned_user_id: string | null; receipt_no: string; transfer_id: string; trace_id: string; case_id: string | null }>(
    `SELECT r.* FROM incoming_referrals r WHERE r.id = $1 AND ${scopeWhere(actor, params)}`,
    params,
  );
  if (!r) throw notFound("연계 신청");
  return r;
}

export async function getReferral(tx: Db, actor: Actor, id: string) {
  const r = await loadScoped(tx, actor, id);
  const versions = await tx.query<{ id: string; version_no: number; payload: Record<string, unknown>; received_at: string; payload_hash: string }>(
    `SELECT id, version_no, payload - '_identity' AS payload, received_at, payload_hash FROM referral_payload_versions WHERE referral_id = $1 ORDER BY version_no DESC`,
    [id],
  );
  const latest = versions[0];
  const consent = latest
    ? await tx.query<{ category: TransferCategory; sensitive: boolean; decision: string; reason: string; purpose: string | null; retention: string; legal_basis: string | null; separate_consent_status: string; consent_recorded_at: string; reviewed_at: string | null }>(
        `SELECT category, sensitive, decision, reason, purpose, retention, legal_basis, separate_consent_status, consent_recorded_at, reviewed_at FROM consent_evidence WHERE payload_version_id = $1 ORDER BY category`,
        [latest.id],
      )
    : [];
  // Mask categories whose legal basis is still under review.
  const pendingCats = new Set(consent.filter((c) => c.decision === "pending_review").map((c) => c.category));
  const payload = latest ? maskPending(latest.payload, pendingCats) : null;
  const events = await tx.query(`SELECT from_status, to_status, actor_label, note, at FROM referral_events WHERE referral_id = $1 ORDER BY at, id`, [id]);
  const messages = await tx.query(`SELECT direction, kind, http_status, error_code, delivery_status, trace_id, at FROM integration_messages WHERE transfer_id = $1 ORDER BY at`, [r.transfer_id]);
  const [region] = r.region_unit_id ? await tx.query<{ name: string }>(`SELECT name FROM region_units WHERE id = $1`, [r.region_unit_id]) : [];
  const [assignee] = r.assigned_user_id ? await tx.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [r.assigned_user_id]) : [];
  await audit(tx, actor, "referral.view", { type: "incoming_referral", id }, "success");
  return {
    referral: { ...r, region_name: region?.name ?? null, assignee_name: assignee?.display_name ?? null },
    payload,
    versions: versions.map((v) => ({ id: v.id, version_no: v.version_no, received_at: v.received_at, payload_hash: v.payload_hash.slice(0, 12) })),
    consent: consent.map((c) => ({ ...c, label: CATEGORY_LABEL[c.category] ?? c.category })),
    events,
    messages,
    allowedTransitions: REFERRAL_TRANSITIONS[r.status],
  };
}

function maskPending(payload: Record<string, unknown>, pending: Set<TransferCategory>) {
  const p = structuredClone(payload) as Record<string, Record<string, unknown> | undefined>;
  const fs = p.functionalSummary;
  if (fs) {
    for (const k of ["kAdl", "fallRisk", "cognition", "principalDiagnosis", "medicationSummary"] as TransferCategory[]) {
      if (pending.has(k) && k in fs) fs[k] = "[법적 근거 검토 전 — 열람 제한]";
    }
  }
  return p;
}

export const referralTransitionBody = z.object({
  to: z.enum(REFERRAL_STATUSES),
  note: z.string().trim().max(500).optional(),
  missingItems: z.array(z.string().trim().min(2).max(80)).max(10).optional(),
  declineReason: z.string().trim().min(5).max(300).optional(),
});

export async function transitionReferral(tx: Db, actor: Actor, id: string, body: z.infer<typeof referralTransitionBody>) {
  const r = await loadScoped(tx, actor, id);
  if (!isAdmin(actor) && r.assigned_user_id !== actor.id) throw forbidden("배정된 담당자 또는 관리자만 상태를 변경할 수 있습니다.");
  if (!canTransition(REFERRAL_TRANSITIONS, r.status, body.to)) throw badTransition(r.status, body.to);
  if (body.to === "ACCEPTED_FOR_ASSESSMENT") throw invalid("접수 완료는 '사례 생성(접수)' 기능으로 처리합니다.");
  if (body.to === "NEEDS_INFORMATION" && !body.missingItems?.length) throw invalid("추가 정보가 필요한 항목을 1개 이상 입력해 주세요.");
  if (body.to === "DECLINED" && !body.declineReason) throw invalid("반려 사유를 입력해 주세요.");
  if (r.consent_check_status === "pending_review" && body.to === "UNDER_REVIEW" && !isAdmin(actor)) {
    // allowed, but surfaced in UI; acceptance is blocked until reviewed (see acceptReferral)
  }
  await tx.query(
    `UPDATE incoming_referrals SET status = $2, missing_items = COALESCE($3, missing_items), decline_reason = COALESCE($4, decline_reason), updated_at = now() WHERE id = $1`,
    [id, body.to, body.missingItems ?? null, body.declineReason ?? null],
  );
  await tx.query(
    `INSERT INTO referral_events (id, tenant_id, referral_id, from_status, to_status, actor_id, actor_label, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [newId("re"), actor.tenantId, id, r.status, body.to, actor.id, actor.name, body.note ?? (body.missingItems ? `보완 요청: ${body.missingItems.join(", ")}` : body.declineReason ?? null)],
  );
  await queueOutboundStatus(tx, actor.tenantId, r.transfer_id, r.trace_id, body.to);
  await audit(tx, actor, "referral.status_change", { type: "incoming_referral", id }, "success", { from: r.status, to: body.to });
  return { from: r.status, to: body.to };
}

export const assignBody = z.object({ userId: z.string().min(3), regionUnitId: z.string().min(3) });

export async function assignReferral(tx: Db, actor: Actor, id: string, body: z.infer<typeof assignBody>) {
  requireRole(actor, "municipal_admin");
  const r = await loadScoped(tx, actor, id);
  const [u] = await tx.query<{ id: string; display_name: string }>(
    `SELECT u.id, u.display_name FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'case_manager'
      WHERE u.id = $1 AND u.is_active`,
    [body.userId],
  );
  if (!u) throw invalid("배정 가능한 활성 담당자가 아닙니다.");
  const [rg] = await tx.query<{ id: string }>(`SELECT id FROM region_units WHERE id = $1`, [body.regionUnitId]);
  if (!rg) throw invalid("담당 지역을 찾을 수 없습니다.");
  await tx.query(`UPDATE incoming_referrals SET assigned_user_id = $2, region_unit_id = $3, updated_at = now() WHERE id = $1`, [id, u.id, rg.id]);
  if (r.status === "RECEIVED") {
    await tx.query(`UPDATE incoming_referrals SET status = 'UNDER_REVIEW' WHERE id = $1`, [id]);
    await queueOutboundStatus(tx, actor.tenantId, r.transfer_id, r.trace_id, "UNDER_REVIEW");
  }
  await tx.query(
    `INSERT INTO referral_events (id, tenant_id, referral_id, from_status, to_status, actor_id, actor_label, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [newId("re"), actor.tenantId, id, r.status, r.status === "RECEIVED" ? "UNDER_REVIEW" : r.status, actor.id, actor.name, `담당자 배정: ${u.display_name}`],
  );
  await tx.query(`UPDATE action_tasks SET assignee_id = $2 WHERE referral_id = $1 AND status = 'open'`, [id, u.id]);
  await notify(tx, actor.tenantId, u.id, "referral_assigned", `${r.receipt_no} 병원 연계 신청이 배정되었습니다.`, `/referrals/${id}`);
  await audit(tx, actor, "referral.assign", { type: "incoming_referral", id }, "success", { assignee: u.id, region: rg.id });
  return { assigned: u.id };
}

export const consentReviewBody = z.object({ category: z.string().min(2).max(40), legalBasisNote: z.string().trim().min(5).max(300) });

/** Admin confirms the legal basis for a category marked pending_review. */
export async function reviewConsentCategory(tx: Db, actor: Actor, id: string, body: z.infer<typeof consentReviewBody>) {
  requireRole(actor, "municipal_admin");
  await loadScoped(tx, actor, id);
  const rows = await tx.query<{ id: string }>(
    `UPDATE consent_evidence SET decision = 'accepted', legal_basis = $3, reviewed_by = $4, reviewed_at = now(), reason = '담당 검토로 법적 근거 확인'
      WHERE referral_id = $1 AND category = $2 AND decision = 'pending_review'
        AND payload_version_id = (SELECT id FROM referral_payload_versions WHERE referral_id = $1 ORDER BY version_no DESC LIMIT 1)
      RETURNING id`,
    [id, body.category, body.legalBasisNote, actor.id],
  );
  if (!rows.length) throw invalid("검토 대기 중인 항목이 아닙니다.");
  const [left] = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM consent_evidence WHERE referral_id = $1 AND decision = 'pending_review'
       AND payload_version_id = (SELECT id FROM referral_payload_versions WHERE referral_id = $1 ORDER BY version_no DESC LIMIT 1)`,
    [id],
  );
  if (left.n === 0) await tx.query(`UPDATE incoming_referrals SET consent_check_status = 'verified', updated_at = now() WHERE id = $1`, [id]);
  await audit(tx, actor, "referral.consent_review", { type: "incoming_referral", id }, "success", { category: body.category });
  return { remainingPending: left.n };
}

export const acceptBody = z.object({ displayName: z.string().trim().min(2).max(30), ageBand: z.string().max(10).optional() });

/** Accept for assessment: creates recipient + case + application, links the referral. */
export async function acceptReferral(tx: Db, actor: Actor, id: string, body: z.infer<typeof acceptBody>) {
  const r = await loadScoped(tx, actor, id);
  if (!isAdmin(actor) && r.assigned_user_id !== actor.id) throw forbidden("배정된 담당자 또는 관리자만 접수할 수 있습니다.");
  if (!canTransition(REFERRAL_TRANSITIONS, r.status, "ACCEPTED_FOR_ASSESSMENT")) throw badTransition(r.status, "ACCEPTED_FOR_ASSESSMENT");
  if (r.consent_check_status !== "verified") throw invalid("법적 근거 검토가 끝나지 않은 항목이 있어 접수할 수 없습니다.");
  if (!r.region_unit_id || !r.assigned_user_id) throw invalid("담당 지역과 담당자를 먼저 배정해 주세요.");
  const [v] = await tx.query<{ payload: { _identity?: { name: string; birthDate: string }; livingNeeds?: { livingArrangement?: string } } }>(
    `SELECT payload FROM referral_payload_versions WHERE referral_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [id],
  );
  const rid = newId("rcp");
  const cid = newId("case");
  const recipientCode = await nextNo(tx, actor.tenantId, "R");
  const caseCode = await nextNo(tx, actor.tenantId, "CASE");
  await tx.query(
    `INSERT INTO care_recipients (id, tenant_id, recipient_code, display_name, age_band, region_unit_id, household_type, is_synthetic) VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
    [rid, actor.tenantId, recipientCode, body.displayName, body.ageBand ?? null, r.region_unit_id, v?.payload.livingNeeds?.livingArrangement ?? null],
  );
  if (v?.payload._identity) {
    await tx.query(
      `INSERT INTO recipient_identities (recipient_id, tenant_id, legal_name, birth_date, external_subject_ref, source_basis) VALUES ($1,$2,$3,$4,$5,$6)`,
      [rid, actor.tenantId, v.payload._identity.name, v.payload._identity.birthDate, r.subject_ref as string, `병원 연계 ${r.receipt_no} (동의 범위 내)`],
    );
  }
  await tx.query(
    `INSERT INTO care_cases (id, tenant_id, case_code, recipient_id, region_unit_id, status, intake_route, primary_worker_id, next_action_at, next_action_label)
     VALUES ($1,$2,$3,$4,$5,'APPLICATION_RECEIVED','hospital_referral',$6,$7,'초기 상담 및 조사 일정 수립')`,
    [cid, actor.tenantId, caseCode, rid, r.region_unit_id, r.assigned_user_id, addDays(3)],
  );
  await tx.query(`INSERT INTO case_assignments (id, tenant_id, case_id, user_id, assignment_role, assigned_by) VALUES ($1,$2,$3,$4,'primary',$5)`, [
    newId("asg"), actor.tenantId, cid, r.assigned_user_id, actor.id,
  ]);
  await tx.query(
    `INSERT INTO applications (id, tenant_id, case_id, application_no, route, applicant_type, incoming_referral_id, summary) VALUES ($1,$2,$3,$4,'hospital_referral','hospital',$5,$6)`,
    [newId("app"), actor.tenantId, cid, await nextNo(tx, actor.tenantId, "APP"), id, `병원 퇴원 연계 ${r.receipt_no}`],
  );
  await tx.query(`UPDATE incoming_referrals SET status = 'ACCEPTED_FOR_ASSESSMENT', case_id = $2, updated_at = now() WHERE id = $1`, [id, cid]);
  await tx.query(
    `INSERT INTO referral_events (id, tenant_id, referral_id, from_status, to_status, actor_id, actor_label, note) VALUES ($1,$2,$3,$4,'ACCEPTED_FOR_ASSESSMENT',$5,$6,$7)`,
    [newId("re"), actor.tenantId, id, r.status, actor.id, actor.name, `사례 ${caseCode} 생성`],
  );
  await tx.query(`UPDATE action_tasks SET status = 'done', completed_at = now() WHERE referral_id = $1 AND status = 'open'`, [id]);
  await addTask(tx, actor.tenantId, { caseId: cid, type: "assessment_due", title: `${caseCode} 기초 조사`, dueAt: addDays(7), assigneeId: r.assigned_user_id });
  await queueOutboundStatus(tx, actor.tenantId, r.transfer_id, r.trace_id, "ACCEPTED_FOR_ASSESSMENT");
  await audit(tx, actor, "referral.status_change", { type: "incoming_referral", id }, "success", { from: r.status, to: "ACCEPTED_FOR_ASSESSMENT", caseId: cid });
  return { caseId: cid, caseCode };
}

/** Requested services from the hospital mapped onto catalog types (for planning hints). */
export const mapRequestedServices = (labels: string[]) => labels.map((l) => HOSPITAL_SERVICE_TO_TYPE[l]).filter(Boolean);
