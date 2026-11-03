/**
 * DEMO seed for a Gangnam-gu reference geography.
 * Administrative area names are real; the municipality, people, cases,
 * partner organisations and service providers are synthetic. Area coordinates
 * are approximate reference points, not official boundary polygons or
 * household/provider locations.
 */
import { createHash } from "node:crypto";
import { DEFAULT_INTAKE_POLICY } from "../../integrations/hospital/consent-scope";
import { ASSESSMENT_DOMAINS, SERVICE_TYPES, SERVICE_TYPE_LABEL, type ServiceType } from "../../domain/enums";
import type { Db } from "./client";
import { hashPassword } from "../auth/password";

export const DEMO_TENANT = "tn_gaon";
export const OTHER_TENANT = "tn_nuri";
export const DEMO_HOSPITAL_KEY_DEFAULT = "demo-hospital-integration-key-not-a-secret";

export const DEMO_USERS = {
  admin: "usr_gaon_admin",
  cmHaesol: "usr_gaon_cm1",
  cmMaru: "usr_gaon_cm2",
  providerNursing: "usr_gaon_pv1",
  providerMeal: "usr_gaon_pv2",
  auditor: "usr_gaon_aud",
  inactive: "usr_gaon_old",
  otherAdmin: "usr_nuri_admin",
} as const;

const day = 86_400_000;
const iso = (offsetDays: number, base = Date.now()) => new Date(base + offsetDays * day).toISOString();
const d = (offsetDays: number) => iso(offsetDays).slice(0, 10);

type Row = Record<string, unknown>;
async function ins(db: Db, table: string, row: Row) {
  const keys = Object.keys(row);
  const vals = keys.map((k) => {
    const v = row[k];
    return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  await db.query(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
}

export const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");

export async function seedIfEmpty(db: Db) {
  const [r] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenants`);
  if ((r?.n ?? 0) > 0) return false;
  await db.transaction((tx) => seed(tx));
  return true;
}

async function seedTenant(db: Db, id: string, code: string, name: string) {
  await ins(db, "tenants", { id, code, name, is_synthetic: true });
  await ins(db, "tenant_settings", {
    tenant_id: id,
    monitoring_interval_days: 30,
    plan_approval_roles: ["municipal_admin"],
    intake_allowed_categories: DEFAULT_INTAKE_POLICY.allowedCategories,
    ai_enabled: false,
    capacity_fresh_days: 14,
  });
  for (const t of SERVICE_TYPES) {
    await ins(db, "service_catalog", { id: `${id}_svc_${t}`, tenant_id: id, service_type: t, name: SERVICE_TYPE_LABEL[t], department: DEPT[t] });
  }
}

const DEPT: Record<ServiceType, string> = {
  visiting_nursing: "보건소 방문보건팀", visiting_health: "보건소 방문보건팀", home_medical_link: "보건소 의약과",
  meal: "복지정책과", mobility: "교통행정과", housework: "노인복지과", home_modification: "건축과·주거복지팀",
  home_care: "노인복지과", ltc_link: "통합돌봄과", cognitive_emotional: "치매안심센터", social_participation: "노인복지과",
  family_caregiver: "가족정책과", local_special: "통합돌봄과",
};

export async function seed(db: Db) {
  const demoPassword = process.env.DEMO_PASSWORD && process.env.DEMO_PASSWORD.length >= 12 ? process.env.DEMO_PASSWORD : null;
  const pw = demoPassword ? await hashPassword(demoPassword) : null;

  /* ---------------- Tenant A: 강남구 지역 참조 시연 (synthetic records) ---------------- */
  const T = DEMO_TENANT;
  await seedTenant(db, T, "DEMO-GANGNAM", "서울특별시 강남구 (DEMO)");
  const regions = [
    {
      id: "rg_gaon", parent_id: null, level: "sigungu", name: "서울특별시 강남구", code: "11680",
      map_x: null, map_y: null, latitude: 37.4951, longitude: 127.06278,
      location_source: "서울특별시 자치구별 동 현황 및 공개 지명 좌표 참고",
      location_precision: "district_reference",
    },
    {
      id: "rg_haesol", parent_id: "rg_gaon", level: "eupmyeondong", name: "역삼1동", code: "GN-YEOKSAM1",
      map_x: null, map_y: null, latitude: 37.50084, longitude: 127.0355,
      location_source: "공개 행정동 중심 좌표 참고",
      location_precision: "approximate_administrative_area_center",
    },
    {
      id: "rg_daon", parent_id: "rg_gaon", level: "eupmyeondong", name: "대치4동", code: "GN-DAECHI4",
      map_x: null, map_y: null, latitude: 37.50157, longitude: 127.0548,
      location_source: "공개 행정동 중심 좌표 참고",
      location_precision: "approximate_administrative_area_center",
    },
    {
      id: "rg_maru", parent_id: "rg_gaon", level: "eupmyeondong", name: "수서동", code: "GN-SUSEO",
      map_x: null, map_y: null, latitude: 37.48692, longitude: 127.1001,
      location_source: "공개 행정동 중심 좌표 참고",
      location_precision: "approximate_administrative_area_center",
    },
    {
      id: "rg_saebom", parent_id: "rg_gaon", level: "eupmyeondong", name: "세곡동", code: "GN-SEGOK",
      map_x: null, map_y: null, latitude: 37.4643, longitude: 127.106,
      location_source: "공개 행정동 중심 좌표 참고",
      location_precision: "approximate_administrative_area_center",
    },
  ];
  for (const rg of regions) await ins(db, "region_units", { ...rg, tenant_id: T, is_synthetic: false });

  const orgs = [
    { id: "org_gaon_city", kind: "municipality", name: "서울특별시 강남구 통합돌봄 시연부서 (DEMO)", region_unit_id: "rg_gaon" },
    { id: "org_gaon_haesol", kind: "eupmyeondong_office", name: "역삼1동 주민센터 시연기관 (DEMO)", region_unit_id: "rg_haesol" },
    { id: "org_gaon_maru", kind: "eupmyeondong_office", name: "수서동 주민센터 시연기관 (DEMO)", region_unit_id: "rg_maru" },
    { id: "org_gaon_hosp", kind: "hospital_partner", name: "늘곁 협력 요양병원 (DEMO)", region_unit_id: "rg_daon", external_code: "SYN-HOSP-01" },
  ];
  for (const o of orgs) await ins(db, "organizations", { ...o, tenant_id: T, is_synthetic: true });

  type P = { id: string; name: string; type: string; region: string; x: number; y: number; days: string[]; services: [ServiceType, string[]][]; cap: [ServiceType, string, number | null][] };
  const providers: P[] = [
    { id: "pv_nursing", name: "역삼1동 방문간호 시연기관 (DEMO)", type: "방문간호기관", region: "rg_haesol", x: 22, y: 34, days: ["mon", "wed", "fri"],
      services: [["visiting_nursing", ["rg_haesol", "rg_daon", "rg_maru"]], ["visiting_health", ["rg_haesol"]]], cap: [["visiting_nursing", "available", 2], ["visiting_health", "limited", 5]] },
    { id: "pv_meal", name: "대치4동 식사지원 시연기관 (DEMO)", type: "사회적협동조합", region: "rg_daon", x: 66, y: 30, days: ["mon", "tue", "wed", "thu", "fri"],
      services: [["meal", ["rg_haesol", "rg_daon", "rg_saebom"]]], cap: [["meal", "available", 1]] },
    { id: "pv_home", name: "수서동 재가돌봄 시연기관 (DEMO)", type: "재가노인복지시설", region: "rg_maru", x: 34, y: 68, days: ["tue", "thu"],
      services: [["home_care", ["rg_maru", "rg_saebom"]], ["housework", ["rg_maru", "rg_saebom", "rg_haesol"]]], cap: [["home_care", "full", 12], ["housework", "available", 0]] },
    { id: "pv_mobility", name: "강남구 이동지원 시연기관 (DEMO)", type: "공공 이동지원", region: "rg_gaon", x: 50, y: 48, days: ["mon", "tue", "wed", "thu", "fri", "sat"],
      services: [["mobility", ["rg_haesol", "rg_daon", "rg_maru", "rg_saebom"]]], cap: [["mobility", "limited", 4]] },
    { id: "pv_housing", name: "세곡동 주거개선 시연기관 (DEMO)", type: "사회적기업", region: "rg_saebom", x: 78, y: 74, days: ["wed"],
      services: [["home_modification", ["rg_gaon", "rg_haesol", "rg_daon", "rg_maru", "rg_saebom"]]], cap: [["home_modification", "available", -40]] },
    { id: "pv_dementia", name: "강남구 인지지원 시연기관 (DEMO)", type: "공공기관", region: "rg_gaon", x: 48, y: 56, days: ["mon", "tue", "wed", "thu", "fri"],
      services: [["cognitive_emotional", ["rg_haesol", "rg_daon", "rg_maru", "rg_saebom"]]], cap: [] },
    { id: "pv_social", name: "역삼1동 사회참여 프로그램 시연기관 (DEMO)", type: "지역사회 프로그램", region: "rg_haesol", x: 28, y: 22, days: ["tue", "fri"],
      services: [["social_participation", ["rg_haesol", "rg_daon"]]], cap: [["social_participation", "available", 3]] },
    { id: "pv_meal2", name: "수서동 식사지원 시연기관 2 (DEMO)", type: "비영리 민간단체", region: "rg_maru", x: 26, y: 78, days: ["mon", "thu"],
      services: [["meal", ["rg_maru", "rg_saebom"]]], cap: [["meal", "limited", -20]] },
  ];
  for (const p of providers) {
    await ins(db, "organizations", { id: `org_${p.id}`, tenant_id: T, kind: "provider", name: p.name, region_unit_id: p.region, is_synthetic: true });
    await ins(db, "service_providers", {
      id: p.id, tenant_id: T, organization_id: `org_${p.id}`, name: p.name, provider_type: p.type, address_label: `${regions.find((r) => r.id === p.region)?.name} (시연 권역 · 실제 기관 주소 아님)`,
      map_x: null, map_y: null, coords_synthetic: true, contact_label: "000-0000-0000 (가상)", operating_hours: "평일 09:00–18:00", visit_days: p.days,
      conditions: "대상자 동의 및 담당자 의뢰 필요", data_source: "DEMO 합성 데이터", is_active: true, is_synthetic: true,
    });
    for (const [t, rs] of p.services) for (const rg of rs) await ins(db, "provider_service_areas", { tenant_id: T, provider_id: p.id, region_unit_id: rg, service_type: t });
    for (const [t, status, offset] of p.cap) {
      // Negative offset = stale (older than 14 days) to demonstrate "확인 필요".
      const age = offset !== null && offset < 0 ? offset : -2;
      await ins(db, "provider_capacity_snapshots", {
        id: `cap_${p.id}_${t}`, tenant_id: T, provider_id: p.id, service_type: t, status,
        waitlist_count: offset !== null && offset >= 0 ? offset : null, confirmed_at: iso(age), source: "기관 회신 (DEMO)",
      });
    }
  }

  const users = [
    { id: DEMO_USERS.admin, org: "org_gaon_city", email: "admin@gangnam.demo", name: "김지원 (DEMO 관리자)", roles: ["municipal_admin"], scope: [], canConfirm: true },
    { id: DEMO_USERS.cmHaesol, org: "org_gaon_haesol", email: "cm.haesol@gaon.demo", name: "이하늘 (DEMO 담당자)", roles: ["case_manager"], scope: ["rg_haesol", "rg_daon"], canConfirm: false },
    { id: DEMO_USERS.cmMaru, org: "org_gaon_maru", email: "cm.maru@gaon.demo", name: "박도윤 (DEMO 담당자)", roles: ["case_manager"], scope: ["rg_maru", "rg_saebom"], canConfirm: false },
    { id: DEMO_USERS.providerNursing, org: "org_pv_nursing", email: "nursing@provider.gangnam.demo", name: "최서연 (DEMO 방문간호)", roles: ["service_provider"], scope: [], provider: "pv_nursing" },
    { id: DEMO_USERS.providerMeal, org: "org_pv_meal", email: "meal@provider.gaon.demo", name: "정민호 (DEMO 식사지원)", roles: ["service_provider"], scope: [], provider: "pv_meal" },
    { id: DEMO_USERS.auditor, org: "org_gaon_city", email: "auditor@gaon.demo", name: "한감사 (DEMO 감사)", roles: ["auditor"], scope: [] },
    { id: DEMO_USERS.inactive, org: "org_gaon_haesol", email: "former@gaon.demo", name: "퇴직자 (DEMO 비활성)", roles: ["case_manager"], scope: ["rg_haesol"], active: false },
  ];
  for (const u of users) {
    await ins(db, "users", {
      id: u.id, tenant_id: T, organization_id: u.org, email: u.email, display_name: u.name, password_hash: pw, is_active: u.active !== false,
      is_demo_account: true, provider_id: (u as { provider?: string }).provider ?? null, can_confirm_official_determination: Boolean(u.canConfirm),
    });
    for (const r of u.roles) await ins(db, "user_roles", { tenant_id: T, user_id: u.id, role: r });
    for (const s of u.scope) await ins(db, "user_region_scopes", { tenant_id: T, user_id: u.id, region_unit_id: s });
  }

  const demoKey = process.env.HOSPITAL_INTEGRATION_DEMO_KEY ?? DEMO_HOSPITAL_KEY_DEFAULT;
  await ins(db, "integration_clients", {
    id: "ic_gaon_hosp", tenant_id: T, source_org_code: "SYN-HOSP-01", source_org_name: "늘곁 협력 요양병원 (DEMO)",
    key_hash: hashKey(demoKey), scopes: ["referrals:write", "referrals:read", "callbacks:write"], is_active: true, is_demo: true,
  });

  /* ---------------- Cases ---------------- */
  type C = { code: string; name: string; age: string; region: string; worker: string; status: string; route: string; household: string; next?: [number, string]; last?: number };
  const cases: C[] = [
    { code: "C-0001", name: "가명 A01", age: "80대", region: "rg_haesol", worker: DEMO_USERS.cmHaesol, status: "SURVEY_IN_PROGRESS", route: "hospital_referral", household: "독거", next: [2, "기초 조사 방문"], last: -3 },
    { code: "C-0002", name: "가명 A02", age: "70대", region: "rg_haesol", worker: DEMO_USERS.cmHaesol, status: "SUPPORT_PLAN_DRAFT", route: "self_application", household: "부부 가구", next: [5, "지원계획 검토 요청"], last: -6 },
    { code: "C-0003", name: "가명 A03", age: "80대", region: "rg_daon", worker: DEMO_USERS.cmHaesol, status: "SERVICE_ACTIVE", route: "agency_referral", household: "독거", next: [-2, "모니터링 전화"], last: -33 },
    { code: "C-0004", name: "가명 A04", age: "90대", region: "rg_daon", worker: DEMO_USERS.cmHaesol, status: "MEETING_SCHEDULED", route: "hospital_referral", household: "자녀 동거", next: [3, "통합지원회의"], last: -4 },
    { code: "C-0005", name: "가명 B01", age: "70대", region: "rg_maru", worker: DEMO_USERS.cmMaru, status: "SERVICE_REFERRAL_PENDING", route: "self_application", household: "독거", next: [1, "제공기관 회신 확인"], last: -2 },
    { code: "C-0006", name: "가명 B02", age: "80대", region: "rg_maru", worker: DEMO_USERS.cmMaru, status: "MONITORING_DUE", route: "outreach", household: "독거", next: [-5, "정기 모니터링"], last: -40 },
    { code: "C-0007", name: "가명 B03", age: "60대", region: "rg_saebom", worker: DEMO_USERS.cmMaru, status: "APPLICATION_RECEIVED", route: "self_application", household: "기타", next: [4, "초기 상담"], last: undefined },
    { code: "C-0008", name: "가명 B04", age: "80대", region: "rg_saebom", worker: DEMO_USERS.cmMaru, status: "SERVICE_ACTIVE", route: "hospital_referral", household: "부부 가구", next: [12, "정기 모니터링"], last: -9 },
    { code: "C-0009", name: "가명 A05", age: "70대", region: "rg_haesol", worker: DEMO_USERS.cmHaesol, status: "ASSESSMENT_REVIEW", route: "outreach", household: "독거", next: [1, "평가 확정 검토"], last: -1 },
    { code: "C-0010", name: "가명 B05", age: "90대", region: "rg_maru", worker: DEMO_USERS.cmMaru, status: "CLOSED", route: "agency_referral", household: "자녀 동거", last: -60 },
  ];
  for (const [i, c] of cases.entries()) {
    const rid = `rcp_${i + 1}`;
    const cid = `case_${i + 1}`;
    await ins(db, "care_recipients", { id: rid, tenant_id: T, recipient_code: `R-${String(i + 1).padStart(4, "0")}`, display_name: c.name, age_band: c.age, region_unit_id: c.region, household_type: c.household, is_synthetic: true });
    await ins(db, "recipient_identities", { recipient_id: rid, tenant_id: T, legal_name: `합성대상자${i + 1}`, birth_date: `19${40 + i}-0${(i % 9) + 1}-15`, contact: null, source_basis: "DEMO 합성 데이터" });
    const closed = c.status === "CLOSED";
    await ins(db, "care_cases", {
      id: cid, tenant_id: T, case_code: c.code, recipient_id: rid, region_unit_id: c.region, status: c.status, intake_route: c.route,
      primary_worker_id: c.worker, opened_at: iso(-40 + i), closed_at: closed ? iso(-10) : null, closure_reason: closed ? "목표 달성 및 대상자 종결 동의 (DEMO)" : null,
      last_contact_at: c.last !== undefined ? iso(c.last) : null, next_action_at: c.next ? iso(c.next[0]) : null, next_action_label: c.next?.[1] ?? null,
    });
    await ins(db, "case_assignments", { id: `asg_${i + 1}`, tenant_id: T, case_id: cid, user_id: c.worker, assignment_role: "primary", assigned_by: DEMO_USERS.admin, assigned_at: iso(-39 + i) });
    await ins(db, "applications", { id: `app_${i + 1}`, tenant_id: T, case_id: cid, application_no: `APP-2026-${String(i + 1).padStart(4, "0")}`, route: c.route,
      applicant_type: c.route === "hospital_referral" ? "hospital" : c.route === "self_application" ? "self" : c.route === "agency_referral" ? "agency" : "official", received_at: iso(-40 + i), summary: "DEMO 신청" });
    await ins(db, "case_records", { id: `rec_${i + 1}a`, tenant_id: T, case_id: cid, record_type: "consultation", body: "초기 상담 진행. 대상자 희망 서비스와 생활 여건을 확인함. (DEMO 합성 기록)", occurred_at: iso(-38 + i), author_id: c.worker });
  }
  await ins(db, "id_counters", { tenant_id: T, prefix: `CASE-${new Date().getFullYear()}`, value: 10 });

  // Assessments
  const assess = async (n: number, status: "draft" | "submitted" | "confirmed", filled: number) => {
    const aid = `asm_${n}`;
    await ins(db, "needs_assessments", { id: aid, tenant_id: T, case_id: `case_${n}`, kind: "municipal_survey", status, surveyed_at: d(-5), surveyor_id: cases[n - 1].worker,
      confirmed_by: status === "confirmed" ? DEMO_USERS.admin : null, confirmed_at: status === "confirmed" ? iso(-4) : null });
    for (const [j, dom] of ASSESSMENT_DOMAINS.entries()) {
      const answered = j < filled;
      await ins(db, "assessment_items", { id: `${aid}_${dom}`, tenant_id: T, assessment_id: aid, domain: dom,
        answer_status: answered ? (j === 7 ? "no_response" : j === 4 ? "needs_followup" : "confirmed") : null,
        value: answered ? SAMPLE_VALUE[dom] : "", note: answered && (j === 4) ? "식사 준비 가능 여부 재방문 시 확인" : "" });
    }
    await ins(db, "home_environment_assessments", { assessment_id: aid, tenant_id: T, housing_type: "다세대·연립", barriers: ["계단", "욕실 문턱"], heating_cooling: "개별 난방", safety_notes: "현관 계단 손잡이 없음 (DEMO)", modification_needed: true });
  };
  await assess(1, "draft", 5);
  await assess(9, "submitted", 11);
  for (const n of [2, 3, 4, 5, 6, 8]) await assess(n, "confirmed", 11);

  // Plans
  const plan = async (n: number, status: string, items: [ServiceType, string | null, string][]) => {
    const pid = `pln_${n}`;
    const approved = ["APPROVED", "REFERRING", "IN_PROGRESS", "CHANGE_REVIEW"].includes(status);
    await ins(db, "support_plans", { id: pid, tenant_id: T, case_id: `case_${n}`, version_no: 1, status, goals: "퇴원 후 안전한 재가 생활 유지 및 일상생활 지원 연계",
      main_needs: "식사 준비 어려움, 외출 시 이동 지원 필요", recipient_wishes: "집에서 계속 생활하고 싶음", additional_checks: "가족 연락 가능 시간 확인",
      start_date: d(-20), review_date: d(70), owner_id: cases[n - 1].worker, approved_by: approved ? DEMO_USERS.admin : null, approved_at: approved ? iso(-18) : null,
      approval_basis: approved ? "통합지원회의 결정 (DEMO)" : null });
    for (const [j, [t, prov, freq]] of items.entries()) {
      await ins(db, "support_plan_items", { id: `${pid}_i${j + 1}`, tenant_id: T, plan_id: pid, service_type: t, department: DEPT[t], provider_id: prov, frequency: freq, start_date: d(-15), end_date: d(75), method: "제공기관 의뢰" });
    }
  };
  await plan(2, "DRAFT", [["meal", null, "주 5회"], ["housework", null, "주 2회"]]);
  await plan(3, "IN_PROGRESS", [["meal", "pv_meal", "주 5회"], ["visiting_nursing", "pv_nursing", "주 1회"]]);
  await plan(4, "MEETING_SCHEDULED", [["visiting_nursing", null, "주 2회"], ["home_modification", null, "1회"]]);
  await plan(5, "REFERRING", [["home_care", "pv_home", "주 3회"], ["meal", null, "주 5회"]]);
  await plan(6, "IN_PROGRESS", [["housework", "pv_home", "주 2회"]]);
  await plan(8, "IN_PROGRESS", [["meal", "pv_meal", "주 3회"]]);

  await ins(db, "integrated_support_meetings", { id: "mtg_4", tenant_id: T, case_id: "case_4", plan_id: "pln_4", scheduled_at: iso(3), status: "scheduled",
    agenda: "퇴원 후 방문간호 및 주거환경 개선 연계 검토", created_by: DEMO_USERS.cmHaesol });
  for (const [j, [o, r]] of [["서울특별시 강남구 통합돌봄 시연부서", "주관"], ["보건소 방문보건팀", "보건"], ["역삼1동 방문간호 시연기관", "제공기관"]].entries())
    await ins(db, "meeting_participants", { id: `mp_4_${j}`, tenant_id: T, meeting_id: "mtg_4", organization_name: `${o} (DEMO)`, participant_role: r });

  // Service referrals
  const sref = async (id: string, n: number, item: string, prov: string, t: ServiceType, status: string, extra: Row = {}) =>
    ins(db, "service_referrals", { id, tenant_id: T, referral_no: `SR-2026-${id.slice(3).padStart(4, "0")}`, case_id: `case_${n}`, plan_item_id: item, provider_id: prov, service_type: t, status,
      request_note: "지원계획에 따른 서비스 의뢰 (DEMO)", requested_by: cases[n - 1].worker, requested_at: iso(-14), ...extra });
  await sref("sr_1", 3, "pln_3_i1", "pv_meal", "meal", "STARTED", { scheduled_start: d(-10), provider_note: "주 5회 배달 진행 중 (DEMO)" });
  await sref("sr_2", 3, "pln_3_i2", "pv_nursing", "visiting_nursing", "SCHEDULED", { scheduled_start: d(2) });
  await sref("sr_3", 5, "pln_5_i1", "pv_home", "home_care", "UNAVAILABLE", { unavailable_reason: "현재 정원 초과로 4주 대기 필요 (DEMO)" });
  await sref("sr_4", 5, "pln_5_i2", "pv_meal", "meal", "REQUESTED", {});
  await sref("sr_5", 6, "pln_6_i1", "pv_home", "housework", "STARTED", { scheduled_start: d(-30) });
  await sref("sr_6", 8, "pln_8_i1", "pv_meal", "meal", "STARTED", { scheduled_start: d(-20) });
  for (const [id, to] of [["sr_1", "STARTED"], ["sr_2", "SCHEDULED"], ["sr_3", "UNAVAILABLE"], ["sr_4", "REQUESTED"], ["sr_5", "STARTED"], ["sr_6", "STARTED"]])
    await ins(db, "service_delivery_events", { id: `sde_${id}`, tenant_id: T, service_referral_id: id, from_status: "REQUESTED", to_status: to, actor_id: DEMO_USERS.admin, actor_kind: "staff", at: iso(-12) });

  await ins(db, "monitoring_records", { id: "mon_3", tenant_id: T, case_id: "case_3", checked_at: iso(-33), method: "phone", service_used: "yes", satisfaction: "satisfied",
    status_change: "특이 변화 없음 (DEMO)", plan_change_needed: false, next_due_at: d(-3), opinion: "서비스 이용 원활", recorded_by: DEMO_USERS.cmHaesol });
  await ins(db, "monitoring_records", { id: "mon_6", tenant_id: T, case_id: "case_6", checked_at: iso(-40), method: "visit", service_used: "partial", satisfaction: "neutral",
    non_delivery_reason: "방문 일정 2회 불일치 (DEMO)", status_change: "", plan_change_needed: true, next_due_at: d(-5), opinion: "제공 일정 조정 필요", recorded_by: DEMO_USERS.cmMaru });

  const task = async (id: string, n: number | null, type: string, title: string, due: number, who: string, referral: string | null = null) =>
    ins(db, "action_tasks", { id, tenant_id: T, case_id: n ? `case_${n}` : null, referral_id: referral, task_type: type, title, due_at: d(due), status: "open", assignee_id: who });
  await task("tsk_1", 3, "monitoring_due", "C-0003 정기 모니터링", -2, DEMO_USERS.cmHaesol);
  await task("tsk_2", 6, "monitoring_due", "C-0006 정기 모니터링", -5, DEMO_USERS.cmMaru);
  await task("tsk_3", 5, "provider_change", "C-0005 재가돌봄 기관 변경 검토", 1, DEMO_USERS.cmMaru);
  await task("tsk_4", 1, "visit_planned", "C-0001 기초 조사 방문", 2, DEMO_USERS.cmHaesol);
  await task("tsk_5", 6, "service_not_delivered", "C-0006 가사지원 미수행 확인", -1, DEMO_USERS.cmMaru);

  /* ---------------- Incoming referrals (synthetic) ---------------- */
  const refRow = async (n: number, status: string, opts: { region?: string; caseId?: string; assigned?: string; missing?: string[]; services: string[]; discharge: number; consent?: string }) => {
    const id = `ir_${n}`;
    const transferId = `SYN-TR-0000${n}`;
    await ins(db, "incoming_referrals", {
      id, tenant_id: T, transfer_id: transferId, receipt_no: `REF-2026-000${n}`, source_org_code: "SYN-HOSP-01", source_org_name: "늘곁 협력 요양병원 (DEMO)",
      received_at: iso(-n), discharge_date: d(opts.discharge), subject_ref: `EXT-${hashKey(`SYN-P-000${n}`).slice(0, 12)}`, subject_display: `연계대상 ${n}`,
      region_unit_id: opts.region ?? null, requested_services: opts.services, status, consent_check_status: opts.consent ?? "verified", schema_version: "1.0",
      trace_id: `trace-demo-000${n}`, validation: { ok: true, issues: [] }, missing_items: opts.missing ?? [], assigned_user_id: opts.assigned ?? null, case_id: opts.caseId ?? null,
    });
    const payload = {
      schemaVersion: "1.0", transferId, source: { facilityId: "SYN-HOSP-01" }, destination: { municipalityCode: "DEMO-GANGNAM" },
      discharge: { plannedDate: d(opts.discharge) },
      functionalSummary: { kAdl: { eating: "부분 도움", mobility: "부분 도움", toileting: "자립" }, cognition: "일상 의사소통 가능", fallRisk: "중간 구간" },
      livingNeeds: { livingArrangement: "독거", housingType: "다세대·연립", barriers: ["계단"], requestedServices: opts.services, socialWorkerNote: "퇴원 후 식사 준비 지원이 필요하다고 응답함 (DEMO)" },
      _identity: { name: `합성연계자${n}`, birthDate: `1942-05-0${n}` },
      consent: { version: "1.0", recordedAt: iso(-n - 1), scope: ["identity", "discharge", "kAdl", "cognition", "fallRisk", "livingNeeds", "socialWorkerNote"], sensitiveInformationConsent: "granted", retention: "untilCaseClosure", legalBasis: "정보주체 동의(개인정보 보호법 제17조·제23조) — DEMO", purpose: "퇴원 후 지역사회 통합돌봄 연계 검토" },
    };
    await ins(db, "referral_payload_versions", { id: `${id}_v1`, tenant_id: T, referral_id: id, version_no: 1, payload, payload_hash: hashKey(JSON.stringify(payload)), received_at: iso(-n) });
    for (const cat of ["identity", "discharge", "kAdl", "cognition", "fallRisk", "livingNeeds", "socialWorkerNote"]) {
      await ins(db, "consent_evidence", { id: `ce_${n}_${cat}`, tenant_id: T, referral_id: id, payload_version_id: `${id}_v1`, category: cat, sensitive: ["kAdl", "cognition", "fallRisk"].includes(cat),
        decision: "accepted", reason: "동의 범위 및 수신 정책 내 항목", purpose: payload.consent.purpose, retention: "untilCaseClosure", legal_basis: payload.consent.legalBasis, separate_consent_status: "granted", consent_recorded_at: payload.consent.recordedAt });
    }
    await ins(db, "referral_events", { id: `re_${n}_1`, tenant_id: T, referral_id: id, from_status: null, to_status: "RECEIVED", actor_label: "시스템 (병원 연계 수신)", note: "스키마 검증 통과", at: iso(-n) });
    if (status !== "RECEIVED") await ins(db, "referral_events", { id: `re_${n}_2`, tenant_id: T, referral_id: id, from_status: "RECEIVED", to_status: status === "ACCEPTED_FOR_ASSESSMENT" ? "UNDER_REVIEW" : status, actor_id: DEMO_USERS.admin, actor_label: "김지원 (DEMO 관리자)", at: iso(-n + 0.5) });
    if (status === "ACCEPTED_FOR_ASSESSMENT") await ins(db, "referral_events", { id: `re_${n}_3`, tenant_id: T, referral_id: id, from_status: "UNDER_REVIEW", to_status: status, actor_id: DEMO_USERS.admin, actor_label: "김지원 (DEMO 관리자)", note: "사례 생성", at: iso(-n + 0.8) });
  };
  await refRow(1, "RECEIVED", { services: ["식사 지원", "방문 간호"], discharge: 6 });
  await refRow(2, "NEEDS_INFORMATION", { region: "rg_haesol", assigned: DEMO_USERS.cmHaesol, missing: ["주거 장애요인 상세", "퇴원 후 식사 준비 가능 여부"], services: ["주거 개선", "식사 지원"], discharge: 9 });
  await refRow(3, "UNDER_REVIEW", { region: "rg_maru", assigned: DEMO_USERS.cmMaru, services: ["이동 지원"], discharge: 4 });
  await refRow(4, "ACCEPTED_FOR_ASSESSMENT", { region: "rg_haesol", assigned: DEMO_USERS.cmHaesol, caseId: "case_1", services: ["방문 간호", "식사 지원"], discharge: -2 });
  await refRow(5, "RECEIVED", { services: ["일상생활 지원"], discharge: 12, consent: "pending_review" });
  await db.query(`UPDATE applications SET incoming_referral_id = 'ir_4' WHERE id = 'app_1'`);
  await ins(db, "id_counters", { tenant_id: T, prefix: `REF-${new Date().getFullYear()}`, value: 5 });
  await ins(db, "id_counters", { tenant_id: T, prefix: `SR-${new Date().getFullYear()}`, value: 6 });
  await ins(db, "id_counters", { tenant_id: T, prefix: `APP-${new Date().getFullYear()}`, value: 10 });

  /* ---------------- Tenant B: 내부 격리 테스트 전용 테넌트 ---------------- */
  const U = OTHER_TENANT;
  await seedTenant(db, U, "DEMO-NURI", "내부 격리 테스트 지자체 (DEMO, 비노출)");
  await ins(db, "region_units", { id: "rg_nuri", tenant_id: U, parent_id: null, level: "sigungu", name: "내부 테스트 권역", code: "NU00", map_x: 50, map_y: 50 });
  await ins(db, "region_units", { id: "rg_nuri_a", tenant_id: U, parent_id: "rg_nuri", level: "eupmyeondong", name: "내부 테스트 읍", code: "NU01", map_x: 40, map_y: 40 });
  await ins(db, "organizations", { id: "org_nuri", tenant_id: U, kind: "municipality", name: "내부 격리 테스트 구청 (DEMO, 비노출)", region_unit_id: "rg_nuri" });
  await ins(db, "users", { id: DEMO_USERS.otherAdmin, tenant_id: U, organization_id: "org_nuri", email: "admin@nuri.demo", display_name: "격리 테스트 관리자 (DEMO, 비노출)", password_hash: pw, is_demo_account: true });
  await ins(db, "user_roles", { tenant_id: U, user_id: DEMO_USERS.otherAdmin, role: "municipal_admin" });
  await ins(db, "care_recipients", { id: "rcp_nuri_1", tenant_id: U, recipient_code: "R-0001", display_name: "가명 N01", age_band: "80대", region_unit_id: "rg_nuri_a" });
  await ins(db, "care_cases", { id: "case_nuri_1", tenant_id: U, case_code: "C-0001", recipient_id: "rcp_nuri_1", region_unit_id: "rg_nuri_a", status: "SURVEY_IN_PROGRESS", intake_route: "self_application", primary_worker_id: DEMO_USERS.otherAdmin });
  await ins(db, "service_providers", { id: "pv_nuri_1", tenant_id: U, organization_id: "org_nuri", name: "격리 테스트 방문간호 (DEMO, 비노출)", provider_type: "방문간호기관", address_label: "내부 테스트 권역 (비노출)", contact_label: "가상", data_source: "DEMO" });
}

const SAMPLE_VALUE: Record<string, string> = {
  basic_profile: "80대, 퇴원 예정 (DEMO)",
  household: "독거, 인근 거주 자녀 주 1회 방문",
  housing: "다세대 2층, 승강기 없음",
  mobility_adl: "실내 보행 가능, 외출 시 도움 필요",
  nutrition: "식사 준비 어려움 호소",
  health_service_use: "정기 외래 진료 이동 지원 필요",
  ltc_care_needs: "장기요양등급 신청 의사 확인 필요",
  social_relations: "",
  family_burden: "자녀 직장으로 상시 돌봄 어려움",
  recipient_wishes: "집에서 계속 생활하고 싶음",
  surveyor_opinion: "식사·이동 지원 우선 검토 필요",
};
