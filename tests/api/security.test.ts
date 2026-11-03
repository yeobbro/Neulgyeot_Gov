import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../lib/server/db/client";
import { withTenant } from "../../lib/server/db/client";
import * as caseRoute from "../../app/api/cases/[id]/route";
import * as casesRoute from "../../app/api/cases/route";
import * as identity from "../../app/api/cases/[id]/identity/route";
import * as records from "../../app/api/cases/[id]/records/route";
import * as planTransition from "../../app/api/cases/[id]/plan/[planId]/transition/route";
import * as providerRef from "../../app/api/provider/referrals/[id]/route";
import * as providerInbox from "../../app/api/provider/referrals/route";
import * as srTransition from "../../app/api/service-referrals/[id]/transition/route";
import * as referralDetail from "../../app/api/referrals/[id]/route";
import * as referralAssign from "../../app/api/referrals/[id]/assign/route";
import * as auditRoute from "../../app/api/audit/route";
import * as adminUsers from "../../app/api/admin/users/route";
import * as dashboardRoute from "../../app/api/dashboard/route";
import * as exportCases from "../../app/api/exports/cases/route";
import { asActor, call, freshDb, DEMO_USERS } from "../helpers";
import { passwordLogin } from "../../lib/server/services/auth";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

test("unauthenticated and inactive users are rejected", async () => {
  assert.equal((await call(casesRoute.GET, {})).status, 401);
  assert.equal((await call(casesRoute.GET, { as: DEMO_USERS.inactive })).status, 401);
  await assert.rejects(passwordLogin(db, { email: "former@gangnam.demo", password: "whatever-password" }), /올바르지|비활성/);
});

test("other tenant's case ID returns 404 (tenant isolation, IDOR)", async () => {
  const r = await call(caseRoute.GET, { as: DEMO_USERS.admin, params: { id: "case_nuri_1" } });
  assert.equal(r.status, 404);
  const r2 = await call(caseRoute.GET, { as: DEMO_USERS.otherAdmin, params: { id: "case_1" } });
  assert.equal(r2.status, 404);
  const list = await call(casesRoute.GET, { as: DEMO_USERS.otherAdmin });
  assert.equal(list.json.total, 1);
});

test("RLS blocks cross-tenant reads and writes even with a raw query", async () => {
  const seen = await withTenant(db, "tn_nuri", (tx) => tx.query<{ id: string }>(`SELECT id FROM care_cases`));
  assert.deepEqual(seen.map((s) => s.id), ["case_nuri_1"]);
  await assert.rejects(
    withTenant(db, "tn_nuri", (tx) => tx.query(`INSERT INTO action_tasks (id, tenant_id, task_type, title) VALUES ('x','tn_gaon','contact_needed','x')`)),
    /row-level security/,
  );
  const none = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE neulgyeot_app`);
    return tx.query(`SELECT id FROM care_cases`);
  });
  assert.equal(none.length, 0, "no tenant set → no rows (fail closed)");
  await assert.rejects(withTenant(db, "tn_gaon", (tx) => tx.query(`DELETE FROM audit_logs`)), /permission denied/);
});

test("case manager cannot read another region's case (404) and cannot write unassigned cases", async () => {
  assert.equal((await call(caseRoute.GET, { as: DEMO_USERS.cmHaesol, params: { id: "case_5" } })).status, 404);
  assert.equal((await call(caseRoute.GET, { as: DEMO_USERS.cmHaesol, params: { id: "case_1" } })).status, 200);
  const list = await call(casesRoute.GET, { as: DEMO_USERS.cmHaesol, url: "/api/cases?pageSize=100" });
  assert.ok(list.json.data.every((c: any) => ["역삼1동", "대치4동"].includes(c.region_name)));
  const write = await call(records.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_1" }, body: { recordType: "note", body: "다른 권역 기록 시도", occurredAt: "2026-11-03T10:00" } });
  assert.equal(write.status, 404);
  const denied = await db.query<any>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'access.denied'`);
  assert.ok(denied[0].n >= 2, "denials are audited");
});

test("direct identifiers are visible only to admin or assigned worker", async () => {
  assert.equal((await call(identity.GET, { as: DEMO_USERS.admin, params: { id: "case_1" } })).status, 200);
  assert.equal((await call(identity.GET, { as: DEMO_USERS.cmHaesol, params: { id: "case_1" } })).status, 200);
  await asActor(db, DEMO_USERS.admin, (tx) => tx.query(`UPDATE case_assignments SET ended_at = now() WHERE case_id = 'case_3'`));
  assert.equal((await call(identity.GET, { as: DEMO_USERS.cmHaesol, params: { id: "case_3" } })).status, 403);
});

test("service provider sees only its own referrals and no case data", async () => {
  const inbox = await call(providerInbox.GET, { as: DEMO_USERS.providerMeal });
  assert.ok(inbox.json.data.length >= 1);
  assert.ok(inbox.json.data.every((r: any) => r.service_type === "meal"));
  assert.equal((await call(providerRef.GET, { as: DEMO_USERS.providerMeal, params: { id: "sr_2" } })).status, 404, "nursing referral not visible to meal provider");
  const own = await call(providerRef.GET, { as: DEMO_USERS.providerMeal, params: { id: "sr_4" } });
  assert.equal(own.status, 200);
  assert.ok(!JSON.stringify(own.json).includes("합성대상자"), "no legal names");
  assert.equal((await call(caseRoute.GET, { as: DEMO_USERS.providerMeal, params: { id: "case_3" } })).status, 404);
  assert.equal((await call(casesRoute.GET, { as: DEMO_USERS.providerMeal })).status, 403);
  assert.equal((await call(srTransition.POST, { as: DEMO_USERS.providerMeal, params: { id: "sr_2" }, body: { to: "ACCEPTED" } })).status, 404);
  assert.equal((await call(srTransition.POST, { as: DEMO_USERS.providerNursing, params: { id: "sr_4" }, body: { to: "ACCEPTED" } })).status, 404);
});

test("staff-only and provider-only transitions are separated", async () => {
  const r = await call(srTransition.POST, { as: DEMO_USERS.admin, params: { id: "sr_4" }, body: { to: "ACCEPTED" } });
  assert.equal(r.status, 403, "staff cannot accept on behalf of provider");
  const u = await call(srTransition.POST, { as: DEMO_USERS.providerMeal, params: { id: "sr_4" }, body: { to: "UNAVAILABLE" } });
  assert.equal(u.status, 400, "unavailable reason is mandatory");
});

test("plan approval API is blocked for users without approval permission", async () => {
  // case_4 plan is MEETING_SCHEDULED; case manager is assigned but lacks approval role.
  const r = await call(planTransition.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_4", planId: "pln_4" }, body: { to: "APPROVED", approvalBasis: "임의 승인 시도" } });
  assert.equal(r.status, 403);
  const admin = await call(planTransition.POST, { as: DEMO_USERS.admin, params: { id: "case_4", planId: "pln_4" }, body: { to: "APPROVED", approvalBasis: "회의 결과 없음" } });
  assert.equal(admin.status, 409, "approval requires a recorded meeting decision");
});

test("auditor sees audit logs but not cases; case managers cannot read audit or admin APIs", async () => {
  assert.equal((await call(auditRoute.GET, { as: DEMO_USERS.auditor })).status, 200);
  assert.equal((await call(caseRoute.GET, { as: DEMO_USERS.auditor, params: { id: "case_1" } })).status, 404);
  assert.equal((await call(dashboardRoute.GET, { as: DEMO_USERS.auditor })).status, 403);
  assert.equal((await call(auditRoute.GET, { as: DEMO_USERS.cmHaesol })).status, 403);
  assert.equal((await call(adminUsers.GET, { as: DEMO_USERS.cmHaesol })).status, 403);
  assert.equal((await call(referralAssign.POST, { as: DEMO_USERS.cmHaesol, params: { id: "ir_1" }, body: { userId: DEMO_USERS.cmHaesol, regionUnitId: "rg_haesol" } })).status, 403);
});

test("unrouted referrals are hidden from case managers", async () => {
  assert.equal((await call(referralDetail.GET, { as: DEMO_USERS.cmHaesol, params: { id: "ir_1" } })).status, 404);
  assert.equal((await call(referralDetail.GET, { as: DEMO_USERS.cmMaru, params: { id: "ir_2" } })).status, 404);
  assert.equal((await call(referralDetail.GET, { as: DEMO_USERS.cmHaesol, params: { id: "ir_2" } })).status, 200);
});

test("CSRF: mutations without the custom header or from another origin are refused", async () => {
  const noHeader = await call(records.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_1" }, body: { recordType: "note", body: "csrf", occurredAt: "2026-11-03T10:00" }, csrf: false });
  assert.equal(noHeader.status, 403);
  const evil = await call(records.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_1" }, body: { recordType: "note", body: "csrf", occurredAt: "2026-11-03T10:00" }, headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
});

test("CSV export contains no recipient names and is logged", async () => {
  await asActor(db, DEMO_USERS.admin, (tx) => tx.query(`UPDATE care_cases SET next_action_label = '=HYPERLINK("http://x")' WHERE id = 'case_2'`));
  const r = await call(exportCases.GET, { as: DEMO_USERS.admin });
  assert.equal(r.status, 200);
  assert.ok(!String(r.json).includes("가명 A01"));
  assert.ok(String(r.json).includes(`"'=HYPERLINK`));
  const [log] = await db.query<any>(`SELECT count(*)::int AS n FROM data_export_logs`);
  assert.ok(log.n >= 1);
});
