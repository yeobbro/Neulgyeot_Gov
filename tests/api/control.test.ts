import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../lib/server/db/client";
import { DEMO_WEARABLE_KEY_DEFAULT } from "../../lib/server/db/seed";
import * as readings from "../../app/api/integrations/wearables/readings/route";
import * as locations from "../../app/api/integrations/locations/route";
import * as dispatches from "../../app/api/cases/[id]/dispatches/route";
import * as dispatchStatus from "../../app/api/dispatches/[id]/route";
import * as alertRoute from "../../app/api/control-alerts/[id]/route";
import * as locConsent from "../../app/api/cases/[id]/location/consent/route";
import * as locWithdraw from "../../app/api/cases/[id]/location/consent/withdraw/route";
import * as designated from "../../app/api/cases/[id]/location/route";
import { controlOverview } from "../../lib/server/services/control";
import { HOSPITAL_KEY, asActor, call, freshDb, DEMO_USERS } from "../helpers";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const gw = (handler: any, body: unknown, key = DEMO_WEARABLE_KEY_DEFAULT) =>
  call(handler, { method: "POST", body, headers: { authorization: `Bearer ${key}` }, csrf: false });
const overview = (user: string) => asActor(db, user, (tx, a) => controlOverview(tx, a));
const subject = async (code: string, user: string = DEMO_USERS.admin) => (await overview(user)).subjects.find((s) => s.caseCode === code)!;

test("readings: scope required; urgent range opens ONE alert, notifies the worker, and a repeat only refreshes it", async () => {
  assert.equal((await gw(readings.POST, {}, HOSPITAL_KEY)).status, 403);
  const body = (m: number) => ({ schemaVersion: "0.1", deviceRef: "SYN-RING-0012", readings: [{ measuredAt: ago(m), heartRate: 131, bodyTempC: 38.9, spo2: 95 }] });
  const r = await gw(readings.POST, body(1));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.alertsOpened, 1);
  assert.equal((await gw(readings.POST, body(0))).json.alertsOpened, 0);
  const rows = await db.query<any>(`SELECT kind, status FROM control_alerts WHERE case_id = 'case_12' AND status <> 'resolved' ORDER BY kind`);
  assert.deepEqual(rows.map((x) => x.kind), ["vital_caution", "vital_urgent"]);
  const [n] = await db.query<any>(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'control_alert' AND link LIKE '%case_12%'`);
  assert.equal(n.n, 1);
  assert.equal((await subject("C-0012")).status, "urgent");
});

test("readings: categories outside consent are rejected whole; old or future timestamps are rejected", async () => {
  // C-0003's consent has heart_rate but not temperature / spo2
  const r = await gw(readings.POST, { schemaVersion: "0.1", deviceRef: "SYN-RING-0003", readings: [{ measuredAt: ago(1), heartRate: 70, bodyTempC: 36.5 }] });
  assert.equal(r.status, 422);
  assert.deepEqual(r.json.error.fields, ["bodyTempC"]);
  const [c] = await db.query<any>(`SELECT count(*)::int AS n FROM wearable_readings WHERE case_id = 'case_3'`);
  assert.equal(c.n, 0);
  assert.equal((await gw(readings.POST, { schemaVersion: "0.1", deviceRef: "SYN-RING-0003", readings: [{ measuredAt: ago(60 * 30), heartRate: 70 }] })).status, 400);
  assert.equal((await gw(readings.POST, { schemaVersion: "0.1", deviceRef: "SYN-RING-0003", readings: [{ measuredAt: ago(-30), heartRate: 70 }] })).status, 400);
});

test("locations: refused without a location consent; accepted with one; withdrawal falls back to the designated location", async () => {
  const fix = (ref: string) => ({ schemaVersion: "0.1", deviceRef: ref, fixes: [{ measuredAt: ago(1), latitude: 37.5, longitude: 127.05, accuracyM: 15 }] });
  const no = await gw(locations.POST, fix("SYN-RING-0003"));
  assert.equal(no.status, 422);
  assert.equal(no.json.error.code, "LOCATION_CONSENT_NOT_ACTIVE");
  assert.equal((await db.query(`SELECT 1 FROM location_fixes WHERE case_id = 'case_3'`)).length, 0);

  const before = await subject("C-0003");
  assert.equal(before.location.mode, "designated");
  const reg = await call(locConsent.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_3" }, body: { legalBasis: "위치정보법 제18조 동의 (테스트)", consentRecordedAt: new Date().toISOString().slice(0, 10), retentionHours: 72, separateConsentConfirmed: true } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal((await gw(locations.POST, fix("SYN-RING-0003"))).status, 200);
  assert.equal((await subject("C-0003")).location.mode, "current");

  assert.equal((await call(locWithdraw.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_3" }, body: {} })).status, 200);
  const after = (await subject("C-0003")).location;
  assert.equal(after.mode, "designated");
  assert.equal(after.mode === "designated" && after.reason, "no_consent");
  assert.equal((await gw(locations.POST, fix("SYN-RING-0003"))).status, 422);
});

test("overview: region scope for case managers; providers and auditors are refused", async () => {
  const maru = await overview(DEMO_USERS.cmMaru);
  assert.ok(maru.subjects.length > 0);
  assert.ok(maru.subjects.every((s) => s.regionId === "rg_maru" || s.regionId === "rg_saebom"));
  assert.ok(maru.staff.every((u) => u.id === DEMO_USERS.cmMaru));
  await assert.rejects(asActor(db, DEMO_USERS.providerNursing, (tx, a) => controlOverview(tx, a)));
  await assert.rejects(asActor(db, DEMO_USERS.auditor, (tx, a) => controlOverview(tx, a)));
  const [log] = await db.query<any>(`SELECT meta FROM audit_logs WHERE action = 'control.view' ORDER BY at DESC LIMIT 1`);
  assert.equal(typeof log.meta.subjects, "number");
});

test("designated location: assigned worker may set it; another region's worker gets 404", async () => {
  const ok = await call(designated.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_1" }, body: { label: "거주지 근사 위치", latitude: 37.501, longitude: 127.036 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await call(designated.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_1" }, body: { label: "x위치", latitude: 37.5, longitude: 127 } })).status, 404);
});

test("dispatch: region-checked assignee, one active per case, linked alert moves to 대응 중, only the assignee advances it", async () => {
  const [alert] = await db.query<any>(`SELECT id FROM control_alerts WHERE case_id = 'case_11' AND kind = 'vital_urgent'`);
  const wrong = await call(dispatches.POST, { as: DEMO_USERS.admin, params: { id: "case_11" }, body: { reason: "현장 확인", assigneeId: DEMO_USERS.cmMaru } });
  assert.equal(wrong.status, 400, "cmMaru does not cover 대치4동");
  const r = await call(dispatches.POST, { as: DEMO_USERS.admin, params: { id: "case_11" }, body: { reason: "현장 확인 요청", alertId: alert.id } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await call(dispatches.POST, { as: DEMO_USERS.admin, params: { id: "case_11" }, body: { reason: "중복 요청" } })).status, 409);
  const [a] = await db.query<any>(`SELECT status FROM control_alerts WHERE id = $1`, [alert.id]);
  assert.equal(a.status, "in_progress");

  assert.equal((await call(dispatchStatus.POST, { as: DEMO_USERS.admin, params: { id: r.json.id }, body: { status: "accepted" } })).status, 403);
  assert.equal((await call(dispatchStatus.POST, { as: DEMO_USERS.cmHaesol, params: { id: r.json.id }, body: { status: "completed" } })).status, 409);
  for (const s of ["accepted", "on_site", "completed"]) assert.equal((await call(dispatchStatus.POST, { as: DEMO_USERS.cmHaesol, params: { id: r.json.id }, body: { status: s } })).status, 200, s);
  assert.equal((await call(dispatches.POST, { as: DEMO_USERS.providerNursing, params: { id: "case_11" }, body: { reason: "x요청" } })).status, 404);
});

test("alerts: closing requires a note; a closed alert cannot be reopened", async () => {
  const [al] = await db.query<any>(`SELECT id FROM control_alerts WHERE case_id = 'case_11' AND kind = 'vital_urgent'`);
  assert.equal((await call(alertRoute.POST, { as: DEMO_USERS.cmHaesol, params: { id: al.id }, body: { status: "resolved" } })).status, 400);
  assert.equal((await call(alertRoute.POST, { as: DEMO_USERS.cmHaesol, params: { id: al.id }, body: { status: "resolved", note: "현장 확인, 감기 증상으로 진료 연계" } })).status, 200);
  assert.equal((await call(alertRoute.POST, { as: DEMO_USERS.cmHaesol, params: { id: al.id }, body: { status: "in_progress" } })).status, 409);
  assert.equal((await call(alertRoute.POST, { as: DEMO_USERS.cmMaru, params: { id: al.id }, body: { status: "in_progress" } })).status, 404);
});
