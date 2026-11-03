import { z } from "zod";
import { CASE_STATUS_LABEL, INTAKE_ROUTE_LABEL, SERVICE_REFERRAL_STATUS_LABEL, SERVICE_TYPE_LABEL, type ServiceType } from "../../domain/enums";
import { STATUS_GROUPS } from "../../domain/metrics";
import { toCsv } from "../../domain/csv";
import type { Actor } from "../auth/session";
import { hasRole } from "../auth/session";
import { audit } from "../audit";
import { isAdmin, isStaff, regionScopeSql, requireRole } from "../authz";
import type { Db } from "../db/client";
import { newId } from "../db/ids";
import { forbidden } from "../errors";

/* ------------------------------ dashboard ------------------------------ */
export async function dashboard(tx: Db, actor: Actor) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const scope = regionScopeSql(actor, "c.region_unit_id", params);
  const byStatus = await tx.query<{ status: string; n: number }>(`SELECT c.status, count(*)::int AS n FROM care_cases c WHERE ${scope} GROUP BY c.status`, params);
  const count = (statuses: string[]) => byStatus.filter((s) => statuses.includes(s.status)).reduce((a, b) => a + b.n, 0);
  const total = byStatus.filter((s) => !["CLOSED", "WITHDRAWN"].includes(s.status)).reduce((a, b) => a + b.n, 0);

  const rp: unknown[] = [];
  const rScope = isAdmin(actor) ? "TRUE" : `(${regionScopeSql(actor, "r.region_unit_id", rp)} OR r.assigned_user_id = $${rp.push(actor.id)})`;
  const [hosp] = await tx.query<{ n: number; total: number }>(
    `SELECT count(*) FILTER (WHERE r.status IN ('RECEIVED','UNDER_REVIEW','RESUBMITTED','NEEDS_INFORMATION'))::int AS n, count(*)::int AS total FROM incoming_referrals r WHERE ${rScope}`,
    rp,
  );
  const tp: unknown[] = [];
  const [overdue] = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM action_tasks t LEFT JOIN care_cases c ON c.id = t.case_id
      WHERE t.status = 'open' AND t.due_at < current_date AND (t.case_id IS NULL OR ${regionScopeSql(actor, "c.region_unit_id", tp)})${isAdmin(actor) ? "" : ` AND (t.assignee_id = $${tp.push(actor.id)})`}`,
    tp,
  );
  const up: unknown[] = [];
  const [unlinked] = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM care_cases c WHERE ${regionScopeSql(actor, "c.region_unit_id", up)}
       AND c.status IN ('SUPPORT_PLAN_APPROVED','SERVICE_REFERRAL_PENDING','PLAN_REVIEW')
       AND NOT EXISTS (SELECT 1 FROM service_referrals s WHERE s.case_id = c.id AND s.status IN ('ACCEPTED','SCHEDULED','STARTED'))`,
    up,
  );
  const metrics = [
    { key: "total", label: "전체 관리 사례", value: total, href: "/cases?filter=open", definition: "종결·철회를 제외한 사례 수" },
    ...["new"].map((k) => ({ key: k, label: STATUS_GROUPS[k].label, value: count(STATUS_GROUPS[k].statuses), href: `/cases?group=${k}`, definition: STATUS_GROUPS[k].definition })),
    { key: "hospital", label: "병원 퇴원 연계 접수", value: hosp?.n ?? 0, href: "/referrals", definition: "처리가 끝나지 않은 병원 연계 신청(신규·확인 중·보완 요청·보완 제출)" },
    ...["survey_wait", "survey", "plan_wait", "meeting", "referral_wait", "active", "monitoring"].map((k) => ({
      key: k, label: STATUS_GROUPS[k].label, value: count(STATUS_GROUPS[k].statuses), href: `/cases?group=${k}`, definition: STATUS_GROUPS[k].definition,
    })),
    { key: "overdue", label: "기한 초과 업무", value: overdue?.n ?? 0, href: "/tasks?overdue=1", definition: "기한일이 지난 미완료 업무", tone: "warn" as const },
    { key: "unlinked", label: "서비스 미연계 사례", value: unlinked?.n ?? 0, href: "/cases?filter=unlinked", definition: "계획 승인 이후 수락·진행 중인 서비스가 없는 사례", tone: "warn" as const },
  ];
  // Regional comparison inside the actor's scope only.
  const gp: unknown[] = [];
  const regions = await tx.query<{ region: string; open: number; monitoring: number; overdue: number }>(
    `SELECT rg.name AS region,
            count(c.id) FILTER (WHERE c.status NOT IN ('CLOSED','WITHDRAWN'))::int AS open,
            count(c.id) FILTER (WHERE c.status = 'MONITORING_DUE')::int AS monitoring,
            count(c.id) FILTER (WHERE c.next_action_at < now() AND c.status NOT IN ('CLOSED','WITHDRAWN'))::int AS overdue
       FROM region_units rg LEFT JOIN care_cases c ON c.region_unit_id = rg.id
      WHERE rg.level = 'eupmyeondong' AND ${regionScopeSql(actor, "rg.id", gp)} GROUP BY rg.name ORDER BY rg.name`,
    gp,
  );
  return { metrics, regions, asOf: new Date().toISOString() };
}

/* -------------------------------- map -------------------------------- */
export async function mapData(tx: Db, actor: Actor) {
  if (!isStaff(actor)) throw forbidden();
  const [municipality] = await tx.query<{
    id: string; name: string; latitude: number | null; longitude: number | null;
    location_source: string | null; location_precision: string | null;
  }>(
    `SELECT id, name, latitude, longitude, location_source, location_precision
       FROM region_units WHERE level = 'sigungu' ORDER BY code LIMIT 1`,
  );
  const regions = await tx.query<{
    id: string; name: string; code: string; latitude: number | null; longitude: number | null;
    location_source: string | null; location_precision: string | null; is_synthetic: boolean;
  }>(
    `SELECT id, name, code, latitude, longitude, location_source, location_precision, is_synthetic
       FROM region_units WHERE level = 'eupmyeondong' ORDER BY code`,
  );
  const params: unknown[] = [];
  const caseCounts = await tx.query<{ region_unit_id: string; n: number }>(
    `SELECT c.region_unit_id, count(*)::int AS n FROM care_cases c WHERE c.status NOT IN ('CLOSED','WITHDRAWN') AND ${regionScopeSql(actor, "c.region_unit_id", params)} GROUP BY 1`,
    params,
  );
  const coverage = await tx.query<{ region_unit_id: string; service_type: ServiceType; n: number }>(
    `SELECT a.region_unit_id, a.service_type, count(DISTINCT a.provider_id)::int AS n FROM provider_service_areas a JOIN service_providers p ON p.id = a.provider_id AND p.is_active GROUP BY 1, 2`,
  );
  const demand = await tx.query<{ region_unit_id: string; service_type: ServiceType; n: number }>(
    `SELECT c.region_unit_id, i.service_type, count(*)::int AS n FROM support_plan_items i JOIN support_plans p ON p.id = i.plan_id JOIN care_cases c ON c.id = p.case_id
      WHERE c.status NOT IN ('CLOSED','WITHDRAWN') GROUP BY 1, 2`,
  );
  const sigungu = (await tx.query<{ id: string }>(`SELECT id FROM region_units WHERE level = 'sigungu'`)).map((r) => r.id);
  const covers = (rid: string, t: ServiceType) => coverage.filter((c) => (c.region_unit_id === rid || sigungu.includes(c.region_unit_id)) && c.service_type === t).reduce((a, b) => a + b.n, 0);
  const out = regions.map((r) => {
    const gaps = demand.filter((d) => d.region_unit_id === r.id && covers(r.id, d.service_type) === 0).map((d) => ({ serviceType: d.service_type, label: SERVICE_TYPE_LABEL[d.service_type], demand: d.n }));
    const types = [...new Set(coverage.filter((c) => c.region_unit_id === r.id || sigungu.includes(c.region_unit_id)).map((c) => c.service_type))];
    const inScope = isAdmin(actor) || actor.regionScope?.includes(r.id);
    return {
      ...r,
      openCases: inScope ? caseCounts.find((c) => c.region_unit_id === r.id)?.n ?? 0 : null,
      serviceTypesCovered: types.length,
      gaps,
    };
  });
  return {
    municipality: municipality ?? null,
    regions: out,
    notice: "서울특별시 강남구의 실제 행정동 명칭과 참고 중심 좌표를 사용합니다. 좌표는 권역 대표점이며 공식 행정경계·개별 주소·기관 위치가 아닙니다.",
    mapSource: "OpenStreetMap",
  };
}

/* ------------------------------- reports ------------------------------- */
export const reportQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type ReportSection = { key: string; title: string; definition: string; formula: string; rows: { label: string; value: number }[]; missing?: { label: string; rate: number } };

export async function buildReport(tx: Db, actor: Actor, q: z.infer<typeof reportQuery>) {
  if (!isStaff(actor)) throw forbidden();
  const from = q.from;
  const to = q.to < q.from ? q.from : q.to;
  const p = (extra: unknown[] = []) => [from, to, ...extra];
  const sc = (col: string, params: unknown[]) => regionScopeSql(actor, col, params);
  const section = async (key: string, title: string, definition: string, formula: string, sql: (params: unknown[]) => string, label: (r: Record<string, unknown>) => string) => {
    const params = p();
    const rows = await tx.query<Record<string, unknown> & { n: number }>(sql(params), params);
    return { key, title, definition, formula, rows: rows.map((r) => ({ label: label(r), value: r.n })) } as ReportSection;
  };
  const sections: ReportSection[] = [];
  sections.push(await section("applications", "기간별 신청·접수 건수", "기간 내 접수된 신청(사례 생성 기준), 신청 경로별", "count(applications) where received_at ∈ [시작, 종료]",
    (ps) => `SELECT a.route AS k, count(*)::int AS n FROM applications a JOIN care_cases c ON c.id = a.case_id WHERE a.received_at::date BETWEEN $1 AND $2 AND ${sc("c.region_unit_id", ps)} GROUP BY 1 ORDER BY 1`,
    (r) => INTAKE_ROUTE_LABEL[r.k as keyof typeof INTAKE_ROUTE_LABEL] ?? String(r.k)));
  sections.push(await section("assessment", "조사 진행 현황", "현재 조사 상태별 건수(기간 내 갱신분)", "count(needs_assessments) group by status",
    (ps) => `SELECT a.status AS k, count(*)::int AS n FROM needs_assessments a JOIN care_cases c ON c.id = a.case_id WHERE a.updated_at::date BETWEEN $1 AND $2 AND ${sc("c.region_unit_id", ps)} GROUP BY 1 ORDER BY 1`,
    (r) => ({ draft: "작성 중", submitted: "검토 요청", confirmed: "확정" })[r.k as string] ?? String(r.k)));
  sections.push(await section("plans", "개인별 지원계획 수립 현황", "기간 내 생성·갱신된 지원계획의 상태별 건수", "count(support_plans) group by status",
    (ps) => `SELECT s.status AS k, count(*)::int AS n FROM support_plans s JOIN care_cases c ON c.id = s.case_id WHERE s.updated_at::date BETWEEN $1 AND $2 AND ${sc("c.region_unit_id", ps)} GROUP BY 1 ORDER BY 1`,
    (r) => String(r.k)));
  sections.push(await section("service_referrals", "서비스 의뢰·제공 현황", "기간 내 의뢰된 서비스의 현재 상태별 건수", "count(service_referrals) where requested_at ∈ 기간 group by status",
    (ps) => `SELECT s.status AS k, count(*)::int AS n FROM service_referrals s JOIN care_cases c ON c.id = s.case_id WHERE s.requested_at::date BETWEEN $1 AND $2 AND ${sc("c.region_unit_id", ps)} GROUP BY 1 ORDER BY 1`,
    (r) => SERVICE_REFERRAL_STATUS_LABEL[r.k as keyof typeof SERVICE_REFERRAL_STATUS_LABEL] ?? String(r.k)));
  sections.push(await section("monitoring", "모니터링 실적", "기간 내 기록된 모니터링 건수(확인 방법별)", "count(monitoring_records) where checked_at ∈ 기간",
    (ps) => `SELECT m.method AS k, count(*)::int AS n FROM monitoring_records m JOIN care_cases c ON c.id = m.case_id WHERE m.checked_at::date BETWEEN $1 AND $2 AND ${sc("c.region_unit_id", ps)} GROUP BY 1 ORDER BY 1`,
    (r) => ({ visit: "방문", phone: "전화", other: "기타" })[r.k as string] ?? String(r.k)));
  sections.push(await section("providers", "기관별 제공 현황", "기간 내 의뢰 기준, 기관별 완료·진행 건수", "count(service_referrals) group by provider where status ∈ {시작, 완료}",
    (ps) => `SELECT pr.name AS k, count(*)::int AS n FROM service_referrals s JOIN service_providers pr ON pr.id = s.provider_id JOIN care_cases c ON c.id = s.case_id
              WHERE s.status IN ('STARTED','COMPLETED') AND s.requested_at::date BETWEEN $1 AND $2 AND ${sc("c.region_unit_id", ps)} GROUP BY 1 ORDER BY 2 DESC`,
    (r) => String(r.k)));
  // Point-in-time sections (기준일 = 생성 시각)
  const sp: unknown[] = [];
  const statusRows = await tx.query<{ k: string; n: number }>(`SELECT c.status AS k, count(*)::int AS n FROM care_cases c WHERE ${sc("c.region_unit_id", sp)} GROUP BY 1 ORDER BY 1`, sp);
  sections.push({ key: "cases_now", title: "사례 상태 현황 (기준일 시점)", definition: "보고서 생성 시점의 사례 상태별 건수", formula: "count(care_cases) group by status", rows: statusRows.map((r) => ({ label: CASE_STATUS_LABEL[r.k as keyof typeof CASE_STATUS_LABEL] ?? r.k, value: r.n })) });
  const dp: unknown[] = [];
  const delays = await tx.query<{ k: string; n: number }>(
    `SELECT t.task_type AS k, count(*)::int AS n FROM action_tasks t LEFT JOIN care_cases c ON c.id = t.case_id WHERE t.status = 'open' AND t.due_at < current_date AND (t.case_id IS NULL OR ${sc("c.region_unit_id", dp)}) GROUP BY 1 ORDER BY 2 DESC`,
    dp,
  );
  sections.push({ key: "delays", title: "처리 지연 및 미완료 업무 (기준일 시점)", definition: "기한일이 지난 미완료 업무, 업무 유형별", formula: "count(action_tasks) where status=open and due_at < 기준일", rows: delays.map((r) => ({ label: r.k, value: r.n })) });
  const gp: unknown[] = [];
  const [unl] = await tx.query<{ n: number; w: number }>(
    `SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM service_referrals s WHERE s.case_id = c.id AND s.status IN ('ACCEPTED','SCHEDULED','STARTED')))::int AS n,
            (SELECT count(*)::int FROM service_referrals s JOIN care_cases c2 ON c2.id = s.case_id WHERE s.status IN ('REQUESTED','UNAVAILABLE','REASSESSMENT_REQUIRED')) AS w
       FROM care_cases c WHERE c.status IN ('SUPPORT_PLAN_APPROVED','SERVICE_REFERRAL_PENDING','PLAN_REVIEW') AND ${sc("c.region_unit_id", gp)}`,
    gp,
  );
  sections.push({ key: "unlinked", title: "미연계 및 대기 현황 (기준일 시점)", definition: "계획 승인 후 진행 중 서비스가 없는 사례 / 회신 대기·수행 불가·재연계 필요 의뢰", formula: "사례: status∈{승인, 의뢰대기, 재검토} ∧ 진행 서비스 없음", rows: [{ label: "서비스 미연계 사례", value: unl?.n ?? 0 }, { label: "회신 대기·수행 불가·재연계 필요 의뢰", value: unl?.w ?? 0 }] });
  const map = await mapData(tx, actor);
  sections.push({ key: "gaps", title: "권역별 서비스 부족", definition: "진행 중 지원계획에 포함된 서비스 유형 중 해당 권역을 담당하는 활성 기관이 없는 경우", formula: "plan_items(권역, 유형) − provider_service_areas(권역, 유형)", rows: map.regions.flatMap((r) => r.gaps.map((g) => ({ label: `${r.name} · ${g.label}`, value: g.demand }))) });
  // Missing-data rate: open cases without a next action date.
  const mp: unknown[] = [];
  const [miss] = await tx.query<{ missing: number; total: number }>(
    `SELECT count(*) FILTER (WHERE c.next_action_at IS NULL)::int AS missing, count(*)::int AS total FROM care_cases c WHERE c.status NOT IN ('CLOSED','WITHDRAWN') AND ${sc("c.region_unit_id", mp)}`,
    mp,
  );
  const ap: unknown[] = [];
  const [amiss] = await tx.query<{ missing: number; total: number }>(
    `SELECT count(*) FILTER (WHERE i.answer_status IS NULL)::int AS missing, count(*)::int AS total FROM assessment_items i JOIN needs_assessments a ON a.id = i.assessment_id JOIN care_cases c ON c.id = a.case_id WHERE ${sc("c.region_unit_id", ap)}`,
    ap,
  );
  return {
    period: { from, to },
    generatedAt: new Date().toISOString(),
    scope: isAdmin(actor) ? "지자체 전체" : "담당 권역",
    sections,
    dataQuality: [
      { label: "다음 조치일 미기재 사례 비율", missing: miss?.missing ?? 0, total: miss?.total ?? 0 },
      { label: "조사 항목 응답 상태 미기재 비율", missing: amiss?.missing ?? 0, total: amiss?.total ?? 0 },
    ],
    notice: "DEMO 합성 데이터 기반 집계입니다. 실제 행정 통계로 사용할 수 없습니다.",
  };
}

export async function saveReportSnapshot(tx: Db, actor: Actor, q: z.infer<typeof reportQuery>) {
  requireRole(actor, "municipal_admin");
  const r = await buildReport(tx, actor, q);
  const id = newId("rpt");
  await tx.query(`INSERT INTO report_snapshots (id, tenant_id, report_type, period_from, period_to, definition, data, generated_by) VALUES ($1,$2,'operations',$3,$4,$5,$6,$7)`, [
    id, actor.tenantId, r.period.from, r.period.to, JSON.stringify(r.sections.map((s) => ({ key: s.key, definition: s.definition, formula: s.formula }))), JSON.stringify(r), actor.id,
  ]);
  return { id };
}

/* ------------------------------- exports ------------------------------- */
export async function exportCasesCsv(tx: Db, actor: Actor) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const rows = await tx.query<Record<string, string | null>>(
    `SELECT c.case_code, rg.name AS region, c.status, c.intake_route, c.opened_at::date::text AS opened, c.next_action_at::date::text AS next_action, c.next_action_label, u.display_name AS worker
       FROM care_cases c JOIN region_units rg ON rg.id = c.region_unit_id LEFT JOIN users u ON u.id = c.primary_worker_id
      WHERE ${regionScopeSql(actor, "c.region_unit_id", params)} ORDER BY c.case_code`,
    params,
  );
  // No recipient names or identifiers: case code only.
  const csv = toCsv(
    ["사례코드", "권역", "사례상태", "신청경로", "개시일", "다음조치일", "다음조치", "담당자"],
    rows.map((r) => [r.case_code, r.region, CASE_STATUS_LABEL[r.status as keyof typeof CASE_STATUS_LABEL] ?? r.status, INTAKE_ROUTE_LABEL[r.intake_route as keyof typeof INTAKE_ROUTE_LABEL] ?? r.intake_route, r.opened, r.next_action, r.next_action_label, r.worker]),
  );
  await logExport(tx, actor, "cases", rows.length, false, {});
  return csv;
}

export async function exportReportCsv(tx: Db, actor: Actor, q: z.infer<typeof reportQuery>) {
  const r = await buildReport(tx, actor, q);
  const csv = toCsv(["구분", "항목", "값", "정의", "산식", "기간", "기준일"], r.sections.flatMap((s) => s.rows.map((row) => [s.title, row.label, row.value, s.definition, s.formula, `${r.period.from}~${r.period.to}`, r.generatedAt])));
  await logExport(tx, actor, "report", r.sections.reduce((a, s) => a + s.rows.length, 0), false, { from: r.period.from, to: r.period.to });
  return csv;
}

export async function logExport(tx: Db, actor: Actor, type: string, rowCount: number, personal: boolean, filters: Record<string, string>, format: "csv" | "print" = "csv") {
  await tx.query(`INSERT INTO data_export_logs (id, tenant_id, actor_id, export_type, format, filters, row_count, contains_personal_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    newId("exp"), actor.tenantId, actor.id, type, format, JSON.stringify(filters), rowCount, personal,
  ]);
  await audit(tx, actor, format === "csv" ? "export.csv" : "export.print", { type: "export", id: type }, "success", { rows: rowCount });
}

/* -------------------------------- audit -------------------------------- */
export const auditQuery = z.object({ action: z.string().max(60).optional(), outcome: z.enum(["success", "denied", "failure"]).optional(), page: z.coerce.number().int().min(1).default(1) });

export async function listAudit(tx: Db, actor: Actor, q: z.infer<typeof auditQuery>) {
  if (!hasRole(actor, "auditor") && !isAdmin(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = ["TRUE"];
  if (q.action) {
    params.push(`${q.action}%`);
    where.push(`a.action LIKE $${params.length}`);
  }
  if (q.outcome) {
    params.push(q.outcome);
    where.push(`a.outcome = $${params.length}`);
  }
  const pageSize = 50;
  params.push(pageSize, (q.page - 1) * pageSize);
  const rows = await tx.query(
    `SELECT a.at, a.action, a.outcome, a.entity_type, a.entity_id, a.actor_role, u.display_name AS actor_name, a.meta
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(" AND ")} ORDER BY a.at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const exports = await tx.query(`SELECT e.at, e.export_type, e.format, e.row_count, e.contains_personal_data, u.display_name AS actor_name FROM data_export_logs e JOIN users u ON u.id = e.actor_id ORDER BY e.at DESC LIMIT 50`);
  const statusHistory = await tx.query(
    `SELECT 'referral' AS kind, ir.receipt_no AS ref, e.from_status, e.to_status, e.actor_label AS actor, e.at FROM referral_events e JOIN incoming_referrals ir ON ir.id = e.referral_id
     UNION ALL SELECT 'service', s.referral_no, e.from_status, e.to_status, e.actor_kind, e.at FROM service_delivery_events e JOIN service_referrals s ON s.id = e.service_referral_id
     ORDER BY at DESC LIMIT 100`,
  );
  return { rows, exports, statusHistory };
}
