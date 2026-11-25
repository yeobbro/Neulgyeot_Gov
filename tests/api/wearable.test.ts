import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../lib/server/db/client";
import { DEMO_WEARABLE_KEY_DEFAULT } from "../../lib/server/db/seed";
import * as intake from "../../app/api/integrations/wearables/daily-summaries/route";
import * as caseWearables from "../../app/api/cases/[id]/wearables/route";
import * as withdraw from "../../app/api/cases/[id]/wearables/withdraw/route";
import * as review from "../../app/api/wearable-signals/[id]/review/route";
import * as tasksRoute from "../../app/api/tasks/route";
import { HOSPITAL_KEY, call, freshDb, DEMO_USERS } from "../helpers";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const send = (body: unknown, key = DEMO_WEARABLE_KEY_DEFAULT) =>
  call(intake.POST, { method: "POST", body, headers: { authorization: `Bearer ${key}`, "x-trace-id": "trace-wear-1" }, csrf: false });
const ring = (summaries: unknown[]) => ({ schemaVersion: "0.1", deviceRef: "SYN-RING-0003", summaries });

test("gateway auth: missing key 401, hospital key lacks wearables scope 403", async () => {
  assert.equal((await call(intake.POST, { method: "POST", body: ring([]), csrf: false })).status, 401);
  assert.equal((await send(ring([{ date: today, wearMinutes: 1300 }]), HOSPITAL_KEY)).status, 403);
});

test("valid summary is stored; response echoes no recipient data", async () => {
  const r = await send(ring([{ date: today, wearMinutes: 1300, steps: 2500, sleepMinutes: 430, restingHeartRate: 65 }]));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.accepted, 1);
  assert.equal(r.json.traceId, "trace-wear-1");
  assert.deepEqual(Object.keys(r.json).sort(), ["accepted", "signalsCreated", "traceId"]);
  const rows = await db.query<any>(`SELECT steps FROM wearable_daily_summaries WHERE device_id = 'wdv_3' AND summary_date = $1`, [today]);
  assert.equal(rows[0].steps, 2500);
  // re-sending the same day updates instead of duplicating
  assert.equal((await send(ring([{ date: today, wearMinutes: 1300, steps: 2550 }]))).status, 200);
  const again = await db.query<any>(`SELECT steps FROM wearable_daily_summaries WHERE device_id = 'wdv_3' AND summary_date = $1`, [today]);
  assert.equal(again.length, 1);
  assert.equal(again[0].steps, 2550);
});

test("metric outside consent → 422 CONSENT_SCOPE_VIOLATION, nothing stored", async () => {
  const date = daysAgo(0);
  const r = await send(ring([{ date, wearMinutes: 1300, spo2Min: 95 }]));
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, "CONSENT_SCOPE_VIOLATION");
  assert.deepEqual(r.json.error.fields, ["spo2Min"]);
  const [row] = await db.query<any>(`SELECT spo2_min FROM wearable_daily_summaries WHERE device_id = 'wdv_3' AND summary_date = $1`, [date]);
  assert.equal(row.spo2_min, null);
});

test("unknown fields, future dates and unregistered devices are rejected", async () => {
  assert.equal((await send(ring([{ date: today, wearMinutes: 1300, latitude: 37.5 }]))).status, 400);
  assert.equal((await send(ring([{ date: "2099-01-01", wearMinutes: 1300 }]))).status, 400);
  const r = await send({ schemaVersion: "0.1", deviceRef: "SYN-RING-9999", summaries: [{ date: today, wearMinutes: 1300 }] });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "DEVICE_NOT_REGISTERED");
});

test("device-reported fall creates a signal attached to ONE open wearable_check task, and notifies the worker", async () => {
  const before = await db.query<any>(`SELECT id FROM action_tasks WHERE case_id = 'case_6' AND task_type = 'wearable_check' AND status = 'open'`);
  assert.equal(before.length, 0);
  const watch = (summaries: unknown[]) => ({ schemaVersion: "0.1", deviceRef: "SYN-WATCH-0006", summaries });
  const r = await send(watch([{ date: daysAgo(1), wearMinutes: 1000, steps: 2000, fallEvents: 1, sosEvents: 0 }]));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.signalsCreated, 1);
  const r2 = await send(watch([{ date: today, wearMinutes: 1000, steps: 2000, fallEvents: 0, sosEvents: 1 }]));
  assert.equal(r2.json.signalsCreated, 1);
  const tasks = await db.query<any>(`SELECT id, due_at, assignee_id FROM action_tasks WHERE case_id = 'case_6' AND task_type = 'wearable_check' AND status = 'open'`);
  assert.equal(tasks.length, 1, "signals are grouped into one task");
  assert.equal(tasks[0].assignee_id, DEMO_USERS.cmMaru);
  const n = await db.query<any>(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'wearable_check'`, [DEMO_USERS.cmMaru]);
  assert.equal(n.length, 1);
  // same day re-sent → no duplicate signal
  assert.equal((await send(watch([{ date: daysAgo(1), wearMinutes: 1000, steps: 2000, fallEvents: 1, sosEvents: 0 }]))).json.signalsCreated, 0);
  const mine = await call(tasksRoute.GET, { as: DEMO_USERS.cmMaru });
  assert.ok(mine.json.data.some((t: any) => t.task_type === "wearable_check"));
  const audits = await db.query<any>(`SELECT meta::text AS m FROM audit_logs WHERE action = 'wearable.intake'`);
  assert.ok(audits.length > 0 && audits.every((a) => !/2000|1000/.test(a.m)), "audit carries no measured values");
});

test("overview: assigned/region staff can read; other region, provider, auditor and other tenant cannot", async () => {
  const ok = await call(caseWearables.GET, { as: DEMO_USERS.cmHaesol, params: { id: "case_3" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.devices[0].device_kind, "smart_ring");
  assert.ok(ok.json.summaries.length >= 14);
  assert.ok(ok.json.signals.some((s: any) => s.signal_type === "activity_drop" && s.status === "open"));
  for (const as of [DEMO_USERS.cmMaru, DEMO_USERS.providerNursing, DEMO_USERS.auditor, DEMO_USERS.otherAdmin])
    assert.equal((await call(caseWearables.GET, { as, params: { id: "case_3" } })).status, 404, as);
});

test("opening the tab raises no_data for a device that has gone quiet (once)", async () => {
  await db.query(`UPDATE wearable_devices SET last_received_at = now() - interval '3 days' WHERE id = 'wdv_6'`);
  const r = await call(caseWearables.GET, { as: DEMO_USERS.cmMaru, params: { id: "case_6" } });
  assert.equal(r.json.signals.filter((s: any) => s.signal_type === "no_data").length, 1);
  const r2 = await call(caseWearables.GET, { as: DEMO_USERS.cmMaru, params: { id: "case_6" } });
  assert.equal(r2.json.signals.filter((s: any) => s.signal_type === "no_data").length, 1);
});

test("signal review: dismiss needs a reason; reviewing the last open signal closes the task; unassigned staff cannot review", async () => {
  const sigs = await db.query<any>(`SELECT id FROM wearable_signals WHERE case_id = 'case_6' AND status = 'open'`);
  assert.ok(sigs.length >= 2);
  assert.equal((await call(review.POST, { as: DEMO_USERS.cmHaesol, params: { id: sigs[0].id }, body: { decision: "acknowledged" } })).status, 404);
  assert.equal((await call(review.POST, { as: DEMO_USERS.cmMaru, params: { id: sigs[0].id }, body: { decision: "dismissed" } })).status, 400);
  for (const [i, s] of sigs.entries()) {
    const r = await call(review.POST, { as: DEMO_USERS.cmMaru, params: { id: s.id }, body: { decision: "acknowledged", note: "전화 확인, 기기 오작동 (DEMO)" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.taskClosed, i === sigs.length - 1);
  }
  assert.equal((await call(review.POST, { as: DEMO_USERS.cmMaru, params: { id: sigs[0].id }, body: { decision: "acknowledged" } })).status, 409);
});

test("register: requires separate consent and the 'wear' metric; one active device per case", async () => {
  const body = {
    clientId: "ic_gaon_wear", deviceKind: "smart_ring", deviceRef: "SYN-RING-0008", modelLabel: "합성 링", metrics: ["wear", "sleep"],
    legalBasis: "정보주체 별도 동의 (DEMO)", consentRecordedAt: today, retentionDays: 90, separateConsentConfirmed: true,
  };
  assert.equal((await call(caseWearables.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_8" }, body: { ...body, separateConsentConfirmed: false } })).status, 400);
  assert.equal((await call(caseWearables.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_8" }, body: { ...body, metrics: ["sleep"] } })).status, 400);
  assert.equal((await call(caseWearables.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_8" }, body: { ...body, clientId: "ic_gaon_hosp" } })).status, 400, "hospital client is not a wearable gateway");
  assert.equal((await call(caseWearables.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_8" }, body })).status, 404, "other region");
  const r = await call(caseWearables.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_8" }, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await call(caseWearables.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_8" }, body: { ...body, deviceRef: "SYN-RING-0009" } })).status, 409);
  // the gateway can now send only the consented metrics
  const ok = await send({ schemaVersion: "0.1", deviceRef: "SYN-RING-0008", summaries: [{ date: today, wearMinutes: 1200, sleepMinutes: 400 }] });
  assert.equal(ok.status, 200);
  const bad = await send({ schemaVersion: "0.1", deviceRef: "SYN-RING-0008", summaries: [{ date: today, wearMinutes: 1200, steps: 10 }] });
  assert.equal(bad.status, 422);
});

test("withdrawn consent pauses the device and later summaries are refused", async () => {
  assert.equal((await call(withdraw.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_8" }, body: {} })).status, 200);
  const r = await send({ schemaVersion: "0.1", deviceRef: "SYN-RING-0008", summaries: [{ date: today, wearMinutes: 1200 }] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, "CONSENT_NOT_ACTIVE");
  assert.equal((await call(withdraw.POST, { as: DEMO_USERS.cmMaru, params: { id: "case_8" }, body: {} })).status, 404);
});

test("RLS: the app role cannot see another tenant's wearable rows", async () => {
  const { withTenant } = await import("../../lib/server/db/client");
  const rows = await withTenant(db, "tn_nuri", (tx) => tx.query(`SELECT 1 FROM wearable_daily_summaries`));
  assert.equal(rows.length, 0);
});
