import { z } from "zod";
import {
  CAPACITY_STATUSES,
  SERVICE_REFERRAL_STATUSES,
  SERVICE_REFERRAL_TRANSITIONS,
  SERVICE_TRANSITION_ACTOR,
  SERVICE_TYPES,
  canTransition,
  type CapacityStatus,
  type ServiceReferralStatus,
  type ServiceType,
} from "../../domain/enums";
import { capacityFreshness, matchProviders, type MatchProvider } from "../../domain/matching";
import type { Actor } from "../auth/session";
import { hasRole } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead, assertCaseWrite, assertProviderReferral, isAdmin, isStaff, regionScopeSql, requireRole } from "../authz";
import type { Db } from "../db/client";
import { newId, nextNo } from "../db/ids";
import { badTransition, conflict, forbidden, invalid, notFound } from "../errors";
import { addDays, addTask, advanceCaseIfValid, notify } from "./common";

async function freshDays(tx: Db, tenantId: string) {
  const [s] = await tx.query<{ capacity_fresh_days: number }>(`SELECT capacity_fresh_days FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
  return s?.capacity_fresh_days ?? 14;
}

async function loadMatchProviders(tx: Db): Promise<MatchProvider[]> {
  const rows = await tx.query<{ id: string; name: string; is_active: boolean; visit_days: string[]; is_synthetic: boolean }>(`SELECT id, name, is_active, visit_days, is_synthetic FROM service_providers`);
  const areas = await tx.query<{ provider_id: string; region_unit_id: string; service_type: ServiceType }>(`SELECT provider_id, region_unit_id, service_type FROM provider_service_areas`);
  const caps = await tx.query<{ provider_id: string; service_type: ServiceType; status: CapacityStatus; confirmed_at: string }>(
    `SELECT DISTINCT ON (provider_id, service_type) provider_id, service_type, status, confirmed_at FROM provider_capacity_snapshots ORDER BY provider_id, service_type, confirmed_at DESC`,
  );
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    isActive: p.is_active,
    visitDays: p.visit_days,
    isSynthetic: p.is_synthetic,
    serviceAreas: areas.filter((a) => a.provider_id === p.id).map((a) => ({ regionUnitId: a.region_unit_id, serviceType: a.service_type })),
    capacity: Object.fromEntries(caps.filter((c) => c.provider_id === p.id).map((c) => [c.service_type, { status: c.status, confirmedAt: new Date(c.confirmed_at).toISOString() }])),
  }));
}

export async function listProviders(tx: Db, actor: Actor, filter: { serviceType?: string; region?: string } = {}) {
  if (!isStaff(actor) && !hasRole(actor, "auditor")) throw forbidden();
  const now = new Date();
  const fd = await freshDays(tx, actor.tenantId);
  const providers = await tx.query<Record<string, unknown> & { id: string }>(
    `SELECT p.id, p.name, p.provider_type, p.address_label, p.map_x, p.map_y, p.coords_synthetic, p.contact_label, p.operating_hours, p.visit_days, p.conditions,
            p.data_source, p.is_active, p.is_synthetic, p.updated_at
       FROM service_providers p ORDER BY p.name`,
  );
  const areas = await tx.query<{ provider_id: string; region_unit_id: string; region_name: string; service_type: ServiceType }>(
    `SELECT a.provider_id, a.region_unit_id, r.name AS region_name, a.service_type FROM provider_service_areas a JOIN region_units r ON r.id = a.region_unit_id`,
  );
  const caps = await tx.query<{ provider_id: string; service_type: ServiceType; status: CapacityStatus; confirmed_at: string; waitlist_count: number | null; source: string }>(
    `SELECT DISTINCT ON (provider_id, service_type) provider_id, service_type, status, confirmed_at, waitlist_count, source FROM provider_capacity_snapshots ORDER BY provider_id, service_type, confirmed_at DESC`,
  );
  let out = providers.map((p) => {
    const pa = areas.filter((a) => a.provider_id === p.id);
    const types = [...new Set(pa.map((a) => a.service_type))];
    return {
      ...p,
      serviceTypes: types,
      regions: [...new Set(pa.map((a) => a.region_name))],
      regionIds: [...new Set(pa.map((a) => a.region_unit_id))],
      capacity: types.map((t) => {
        const c = caps.find((x) => x.provider_id === p.id && x.service_type === t);
        return { serviceType: t, waitlist: c?.waitlist_count ?? null, source: c?.source ?? null, ...capacityFreshness(c ? { status: c.status, confirmedAt: new Date(c.confirmed_at).toISOString() } : null, now, fd) };
      }),
    };
  });
  if (filter.serviceType) out = out.filter((p) => p.serviceTypes.includes(filter.serviceType as ServiceType));
  if (filter.region) out = out.filter((p) => p.regionIds.includes(filter.region!));
  return out;
}

export const capacityBody = z.object({ serviceType: z.enum(SERVICE_TYPES), status: z.enum(CAPACITY_STATUSES), waitlistCount: z.number().int().min(0).max(999).nullable().optional() });

/** Providers update their own capacity; admins may record a phone confirmation. */
export async function updateCapacity(tx: Db, actor: Actor, providerId: string, b: z.infer<typeof capacityBody>) {
  const own = hasRole(actor, "service_provider") && actor.providerId === providerId;
  if (!own && !isAdmin(actor)) throw forbidden();
  const [area] = await tx.query(`SELECT 1 FROM provider_service_areas WHERE provider_id = $1 AND service_type = $2 LIMIT 1`, [providerId, b.serviceType]);
  if (!area) throw invalid("이 기관이 제공하지 않는 서비스 유형입니다.");
  await tx.query(
    `INSERT INTO provider_capacity_snapshots (id, tenant_id, provider_id, service_type, status, waitlist_count, confirmed_at, confirmed_by, source) VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)`,
    [newId("cap"), actor.tenantId, providerId, b.serviceType, b.status, b.waitlistCount ?? null, actor.id, own ? "제공기관 직접 입력" : "지자체 확인 (전화 등)"],
  );
  await audit(tx, actor, "provider.capacity_update", { type: "service_provider", id: providerId }, "success", { serviceType: b.serviceType, status: b.status });
  return { ok: true };
}

export async function matchForPlanItem(tx: Db, actor: Actor, caseId: string, planItemId: string) {
  const c = await assertCaseRead(tx, actor, caseId);
  const [item] = await tx.query<{ service_type: ServiceType }>(
    `SELECT i.service_type FROM support_plan_items i JOIN support_plans p ON p.id = i.plan_id WHERE i.id = $1 AND p.case_id = $2`,
    [planItemId, caseId],
  );
  if (!item) throw notFound("지원계획 항목");
  const regions = await tx.query<{ id: string }>(
    `WITH RECURSIVE up AS (SELECT id, parent_id FROM region_units WHERE id = $1 UNION SELECT r.id, r.parent_id FROM region_units r JOIN up ON r.id = up.parent_id) SELECT id FROM up`,
    [c.region_unit_id],
  );
  const result = matchProviders({ serviceType: item.service_type, regionUnitIds: regions.map((r) => r.id) }, await loadMatchProviders(tx), new Date());
  return { serviceType: item.service_type, ...result };
}

/* --------------------------- service referrals --------------------------- */
export const serviceReferralCreateBody = z.object({ planItemId: z.string().min(3), providerId: z.string().min(3), requestNote: z.string().trim().min(5).max(1000), send: z.boolean().default(true) });

export async function createServiceReferral(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof serviceReferralCreateBody>) {
  await assertCaseWrite(tx, actor, caseId);
  const [item] = await tx.query<{ service_type: ServiceType; plan_status: string; plan_id: string }>(
    `SELECT i.service_type, p.status AS plan_status, p.id AS plan_id FROM support_plan_items i JOIN support_plans p ON p.id = i.plan_id WHERE i.id = $1 AND p.case_id = $2`,
    [b.planItemId, caseId],
  );
  if (!item) throw notFound("지원계획 항목");
  if (!["APPROVED", "REFERRING", "IN_PROGRESS"].includes(item.plan_status)) throw conflict("승인된 개인별 지원계획의 항목만 의뢰할 수 있습니다.");
  const [offers] = await tx.query(`SELECT 1 FROM provider_service_areas WHERE provider_id = $1 AND service_type = $2 LIMIT 1`, [b.providerId, item.service_type]);
  if (!offers) throw invalid("선택한 기관은 해당 서비스를 제공하지 않습니다.");
  const [active] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_referrals WHERE plan_item_id = $1 AND status IN ('DRAFT','REQUESTED','ACCEPTED','SCHEDULED','STARTED')`, [b.planItemId]);
  if (active.n > 0) throw conflict("이 항목에 진행 중인 의뢰가 이미 있습니다.");
  const id = newId("sr");
  const status: ServiceReferralStatus = b.send ? "REQUESTED" : "DRAFT";
  const no = await nextNo(tx, actor.tenantId, "SR");
  await tx.query(
    `INSERT INTO service_referrals (id, tenant_id, referral_no, case_id, plan_item_id, provider_id, service_type, status, request_note, requested_by, requested_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $8 = 'REQUESTED' THEN now() END)`,
    [id, actor.tenantId, no, caseId, b.planItemId, b.providerId, item.service_type, status, b.requestNote, actor.id],
  );
  await tx.query(`UPDATE support_plan_items SET provider_id = $2 WHERE id = $1`, [b.planItemId, b.providerId]);
  await tx.query(`INSERT INTO service_delivery_events (id, tenant_id, service_referral_id, from_status, to_status, note, actor_id, actor_kind) VALUES ($1,$2,$3,NULL,$4,$5,$6,'staff')`, [
    newId("sde"), actor.tenantId, id, status, "의뢰서 생성", actor.id,
  ]);
  if (item.plan_status === "APPROVED") await tx.query(`UPDATE support_plans SET status = 'REFERRING', version = version + 1, updated_at = now() WHERE id = $1`, [item.plan_id]);
  await advanceCaseIfValid(tx, actor, caseId, "SERVICE_REFERRAL_PENDING");
  if (status === "REQUESTED") {
    const providerUsers = await tx.query<{ id: string }>(`SELECT id FROM users WHERE provider_id = $1 AND is_active`, [b.providerId]);
    for (const u of providerUsers) await notify(tx, actor.tenantId, u.id, "service_referral", `새 서비스 의뢰 ${no}`, `/provider/referrals/${id}`);
  }
  await audit(tx, actor, "service_referral.create", { type: "service_referral", id }, "success", { provider: b.providerId, serviceType: item.service_type, status });
  return { id, referralNo: no, status };
}

export const serviceTransitionBody = z.object({
  to: z.enum(SERVICE_REFERRAL_STATUSES),
  note: z.string().trim().max(1000).optional(),
  unavailableReason: z.string().trim().min(5).max(300).optional(),
  scheduledStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expectedVersion: z.number().int().optional(),
});

const CASE_EFFECT: Partial<Record<ServiceReferralStatus, "PROVIDER_ACCEPTED" | "SERVICE_SCHEDULED" | "SERVICE_ACTIVE" | "PLAN_REVIEW">> = {
  ACCEPTED: "PROVIDER_ACCEPTED",
  SCHEDULED: "SERVICE_SCHEDULED",
  STARTED: "SERVICE_ACTIVE",
  REASSESSMENT_REQUIRED: "PLAN_REVIEW",
};

export async function transitionServiceReferral(tx: Db, actor: Actor, id: string, b: z.infer<typeof serviceTransitionBody>) {
  const isProvider = hasRole(actor, "service_provider");
  let r: { id: string; status: ServiceReferralStatus; case_id: string; version: number; referral_no: string; requested_by: string; plan_item_id: string };
  if (isProvider) {
    await assertProviderReferral(tx, actor, id);
    [r] = await tx.query(`SELECT id, status, case_id, version, referral_no, requested_by, plan_item_id FROM service_referrals WHERE id = $1 FOR UPDATE`, [id]);
  } else {
    const [row] = await tx.query<typeof r>(`SELECT id, status, case_id, version, referral_no, requested_by, plan_item_id FROM service_referrals WHERE id = $1 FOR UPDATE`, [id]);
    if (!row) throw notFound("의뢰");
    await assertCaseWrite(tx, actor, row.case_id);
    r = row;
  }
  if (b.expectedVersion !== undefined && b.expectedVersion !== r.version) throw conflict("다른 사용자가 먼저 처리했습니다. 새로고침 후 다시 시도해 주세요.");
  if (!canTransition(SERVICE_REFERRAL_TRANSITIONS, r.status, b.to)) throw badTransition(r.status, b.to);
  const who = SERVICE_TRANSITION_ACTOR[b.to];
  if (who === "provider" && !isProvider) throw forbidden("제공기관만 처리할 수 있는 단계입니다.");
  if (who === "staff" && isProvider) throw forbidden("지자체 담당자만 처리할 수 있는 단계입니다.");
  if (b.to === "UNAVAILABLE" && !b.unavailableReason) throw invalid("수행 불가 사유를 입력해 주세요.");
  if (b.to === "SCHEDULED" && !b.scheduledStart) throw invalid("서비스 시작 예정일을 입력해 주세요.");
  if ((b.to === "COMPLETED" || b.to === "REASSESSMENT_REQUIRED" || b.to === "CANCELED") && (!b.note || b.note.length < 5)) throw invalid("수행 결과 또는 사유를 5자 이상 입력해 주세요.");
  await tx.query(
    `UPDATE service_referrals SET status = $2, unavailable_reason = COALESCE($3, unavailable_reason), scheduled_start = COALESCE($4::date, scheduled_start),
        provider_note = CASE WHEN $5::boolean THEN COALESCE($6, provider_note) ELSE provider_note END,
        completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
        requested_at = CASE WHEN $2 = 'REQUESTED' THEN now() ELSE requested_at END, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, b.to, b.unavailableReason ?? null, b.scheduledStart ?? null, isProvider, b.note ?? null],
  );
  await tx.query(`INSERT INTO service_delivery_events (id, tenant_id, service_referral_id, from_status, to_status, note, actor_id, actor_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    newId("sde"), actor.tenantId, id, r.status, b.to, b.unavailableReason ?? b.note ?? (b.scheduledStart ? `시작 예정일 ${b.scheduledStart}` : null), actor.id, isProvider ? "provider" : "staff",
  ]);
  const effect = CASE_EFFECT[b.to];
  if (effect) await advanceCaseIfValid(tx, actor, r.case_id, effect);
  if (b.to === "STARTED") {
    await tx.query(`UPDATE support_plans SET status = 'IN_PROGRESS', version = version + 1 WHERE id = (SELECT plan_id FROM support_plan_items WHERE id = $1) AND status = 'REFERRING'`, [r.plan_item_id]);
    const [s] = await tx.query<{ monitoring_interval_days: number }>(`SELECT monitoring_interval_days FROM tenant_settings WHERE tenant_id = $1`, [actor.tenantId]);
    await tx.query(`UPDATE care_cases SET next_action_at = $2, next_action_label = '정기 모니터링' WHERE id = $1`, [r.case_id, addDays(s?.monitoring_interval_days ?? 30)]);
  }
  if (b.to === "UNAVAILABLE") {
    const [c] = await tx.query<{ primary_worker_id: string | null }>(`SELECT primary_worker_id FROM care_cases WHERE id = $1`, [r.case_id]);
    await addTask(tx, actor.tenantId, { caseId: r.case_id, type: "provider_change", title: `${r.referral_no} 수행 불가 — 대체 기관 검토`, dueAt: addDays(3), assigneeId: c?.primary_worker_id });
  }
  if (isProvider) await notify(tx, actor.tenantId, r.requested_by, "service_referral_update", `${r.referral_no} 상태 변경: ${b.to}`, `/cases/${r.case_id}?tab=services`);
  await audit(tx, actor, "service_referral.status_change", { type: "service_referral", id }, "success", { from: r.status, to: b.to });
  return { from: r.status, to: b.to };
}

export async function listServiceReferralsForCase(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  const rows = await tx.query(
    `SELECT s.id, s.referral_no, s.service_type, s.status, s.request_note, s.provider_note, s.unavailable_reason, s.scheduled_start, s.completed_at, s.requested_at, s.updated_at, s.version,
            p.name AS provider_name, s.plan_item_id
       FROM service_referrals s JOIN service_providers p ON p.id = s.provider_id WHERE s.case_id = $1 ORDER BY s.updated_at DESC`,
    [caseId],
  );
  const events = await tx.query(
    `SELECT e.service_referral_id, e.from_status, e.to_status, e.note, e.actor_kind, e.at, u.display_name AS actor_name
       FROM service_delivery_events e JOIN users u ON u.id = e.actor_id WHERE e.service_referral_id IN (SELECT id FROM service_referrals WHERE case_id = $1) ORDER BY e.at`,
    [caseId],
  );
  return { referrals: rows, events };
}

/** Tenant-wide service referral board for staff (region scoped). */
export async function listServiceReferrals(tx: Db, actor: Actor, status?: string) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = [regionScopeSql(actor, "c.region_unit_id", params)];
  if (status && (SERVICE_REFERRAL_STATUSES as readonly string[]).includes(status)) {
    params.push(status);
    where.push(`s.status = $${params.length}`);
  }
  return tx.query(
    `SELECT s.id, s.referral_no, s.service_type, s.status, s.scheduled_start, s.updated_at, s.unavailable_reason, p.name AS provider_name, c.id AS case_id, c.case_code, rg.name AS region_name
       FROM service_referrals s JOIN care_cases c ON c.id = s.case_id JOIN service_providers p ON p.id = s.provider_id JOIN region_units rg ON rg.id = c.region_unit_id
      WHERE ${where.join(" AND ")} ORDER BY s.updated_at DESC LIMIT 300`,
    params,
  );
}

/* ----------------------------- provider portal ----------------------------- */
/**
 * Provider view: only referrals addressed to the provider, with the minimum
 * needed to deliver the service — no internal memos, assessments or identifiers.
 */
export async function providerInbox(tx: Db, actor: Actor) {
  requireRole(actor, "service_provider");
  if (!actor.providerId) throw forbidden();
  return tx.query(
    `SELECT s.id, s.referral_no, s.service_type, s.status, s.requested_at, s.scheduled_start, s.updated_at, c.case_code, rg.name AS region_name, i.frequency
       FROM service_referrals s JOIN care_cases c ON c.id = s.case_id JOIN region_units rg ON rg.id = c.region_unit_id JOIN support_plan_items i ON i.id = s.plan_item_id
      WHERE s.provider_id = $1 AND s.status <> 'DRAFT' ORDER BY s.updated_at DESC`,
    [actor.providerId],
  );
}

export async function providerReferralDetail(tx: Db, actor: Actor, id: string) {
  await assertProviderReferral(tx, actor, id);
  const [r] = await tx.query(
    `SELECT s.id, s.referral_no, s.service_type, s.status, s.request_note, s.provider_note, s.unavailable_reason, s.scheduled_start, s.completed_at, s.requested_at, s.version,
            c.case_code, r.display_name AS recipient_alias, r.age_band, rg.name AS region_name, i.frequency, i.method, i.start_date, i.end_date, u.display_name AS requested_by_name
       FROM service_referrals s JOIN care_cases c ON c.id = s.case_id JOIN care_recipients r ON r.id = c.recipient_id JOIN region_units rg ON rg.id = c.region_unit_id
       JOIN support_plan_items i ON i.id = s.plan_item_id JOIN users u ON u.id = s.requested_by WHERE s.id = $1`,
    [id],
  );
  const events = await tx.query(`SELECT from_status, to_status, note, actor_kind, at FROM service_delivery_events WHERE service_referral_id = $1 ORDER BY at`, [id]);
  await audit(tx, actor, "case.view", { type: "service_referral", id }, "success", { provider: true });
  return { referral: r, events, allowed: SERVICE_REFERRAL_TRANSITIONS[(r as { status: ServiceReferralStatus }).status].filter((s) => SERVICE_TRANSITION_ACTOR[s] !== "staff") };
}
