import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../lib/server/db/client";
import { DEMO_WEARABLE_KEY_DEFAULT } from "../../lib/server/db/seed";
import * as intake from "../../app/api/integrations/wearables/daily-summaries/route";
import * as locations from "../../app/api/integrations/locations/route";
import * as caseWearables from "../../app/api/cases/[id]/wearables/route";
import * as locConsent from "../../app/api/cases/[id]/location/consent/route";
import { controlOverview } from "../../lib/server/services/control";
import { asActor, call, freshDb, DEMO_USERS } from "../helpers";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

const today = new Date().toISOString().slice(0, 10);
const send = (body: unknown) => call(intake.POST, { method: "POST", body, headers: { authorization: `Bearer ${DEMO_WEARABLE_KEY_DEFAULT}` }, csrf: false });
const reg = (body: Record<string, unknown>) => call(caseWearables.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_1" }, body: {
  clientId: "ic_gaon_wear", deviceKind: "smart_ring", deviceProfile: "sigring100", deviceRef: "SIGRING-TEST-0001", modelLabel: "SIGRING100",
  metrics: ["wear", "sleep", "vitality", "hrv", "skin_temp"], legalBasis: "정보주체 별도 동의 (DEMO)", consentRecordedAt: today, retentionDays: 90, separateConsentConfirmed: true, ...body,
} });

test("registration refuses consent categories the device cannot measure, and a profile of the wrong kind", async () => {
  const r = await reg({ metrics: ["wear", "fall", "sos"] });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json.error.details.unsupported, ["fall", "sos"]);
  assert.equal((await reg({ deviceKind: "smart_watch" })).status, 400);
  const ok = await reg({});
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const [d] = await db.query<any>(`SELECT device_profile FROM wearable_devices WHERE id = $1`, [ok.json.id]);
  assert.equal(d.device_profile, "sigring100");
});

test("contract 0.2 carries ring metrics; 0.1 refuses them; values are stored and compared with the usual", async () => {
  const v01 = await send({ schemaVersion: "0.1", deviceRef: "SIGRING-TEST-0001", summaries: [{ date: today, wearMinutes: 1300, vitalityScore: 80 }] });
  assert.equal(v01.status, 400);
  const r = await send({ schemaVersion: "0.2", deviceRef: "SIGRING-TEST-0001", summaries: [{ date: today, wearMinutes: 1300, sleepMinutes: 420, sleepDeepMinutes: 80, vitalityScore: 81, hrvRmssd: 31, skinTempDeviationC: 1.4 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.signalsCreated, 1, "skin temperature rise needs no baseline window");
  const [row] = await db.query<any>(`SELECT vitality_score, hrv_rmssd, skin_temp_dev_c, sleep_deep_minutes FROM wearable_daily_summaries WHERE case_id = 'case_1'`);
  assert.deepEqual([row.vitality_score, row.hrv_rmssd, row.skin_temp_dev_c, row.sleep_deep_minutes], [81, 31, 1.4, 80]);
  // stress was not consented → whole payload refused
  const bad = await send({ schemaVersion: "0.2", deviceRef: "SIGRING-TEST-0001", summaries: [{ date: today, wearMinutes: 1300, stressIndex: 40 }] });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.json.error.fields, ["stressIndex"]);
});

test("no location for a device without GPS: consent registration and gateway fixes are both refused", async () => {
  const c = await call(locConsent.POST, { as: DEMO_USERS.cmHaesol, params: { id: "case_1" }, body: { legalBasis: "위치정보법 동의", consentRecordedAt: today, retentionHours: 72, separateConsentConfirmed: true } });
  assert.equal(c.status, 400);
  assert.match(c.json.error.message, /위치\(GPS\) 기능이 없어/);
  const f = await call(locations.POST, { method: "POST", csrf: false, headers: { authorization: `Bearer ${DEMO_WEARABLE_KEY_DEFAULT}` },
    body: { schemaVersion: "0.1", deviceRef: "SIGRING-SYN-0016", fixes: [{ measuredAt: new Date().toISOString(), latitude: 37.47, longitude: 127.1 }] } });
  assert.equal(f.status, 422);
  assert.equal(f.json.error.code, "DEVICE_HAS_NO_LOCATION");
});

test("control view: a daily-sync ring is 'normal' without real-time readings; the morning summary flags the vitality drop", async () => {
  const o = await asActor(db, DEMO_USERS.admin, (tx, a) => controlOverview(tx, a));
  const steady = o.subjects.find((s) => s.caseCode === "C-0016")!;
  assert.equal(steady.status, "normal");
  assert.equal(steady.device?.realtime, false);
  assert.equal(steady.device?.linked, true);
  assert.equal(steady.location.mode, "designated");
  const drop = o.morning.find((m) => m.caseId === "case_15")!;
  assert.equal(o.morning[0].caseId, "case_15", "people with open signals come first");
  assert.ok(drop.openSignals > 0);
  assert.ok(drop.vitalityUsual! - drop.vitality! >= 10);
  assert.equal(o.subjects.find((s) => s.caseCode === "C-0015")!.status, "caution");
});
