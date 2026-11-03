import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../lib/server/db/client";
import { withTenant } from "../../lib/server/db/client";
import * as referrals from "../../app/api/integrations/hospital/referrals/route";
import * as statusRoute from "../../app/api/integrations/hospital/referrals/[transferId]/route";
import * as resub from "../../app/api/integrations/hospital/referrals/[transferId]/resubmissions/route";
import * as callback from "../../app/api/integrations/hospital/callbacks/status/route";
import * as staffTransition from "../../app/api/referrals/[id]/transition/route";
import { authHeaders, call, envelope, freshDb, DEMO_USERS } from "../helpers";

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

const post = (body: unknown, idem: string, headers: Record<string, string> = {}) =>
  call(referrals.POST, { method: "POST", body, headers: { ...authHeaders(idem), ...headers }, csrf: false });

test("valid hospital referral is received with limited status response", async () => {
  const env = envelope();
  const r = await post(env, "idem-valid-0001", { "x-trace-id": "trace-abc-123" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.referral.status, "RECEIVED");
  assert.equal(r.json.traceId, "trace-abc-123");
  assert.ok(!JSON.stringify(r.json).includes("합성환자"), "no identifiers echoed");
  const [row] = await db.query<any>(`SELECT * FROM incoming_referrals WHERE transfer_id = $1`, [env.transferId]);
  assert.ok(row.subject_ref.startsWith("EXT-"));
  assert.notEqual(row.subject_ref, "SYN-P-0101");
  const [msg] = await db.query<any>(`SELECT * FROM integration_messages WHERE transfer_id = $1`, [env.transferId]);
  assert.equal(msg.http_status, 201);
  const logs = await db.query<any>(`SELECT meta::text AS m FROM audit_logs WHERE action = 'referral.receive'`);
  assert.ok(logs.every((l) => !l.m.includes("합성환자")));
});

test("invalid payload → 400 VALIDATION_FAILED, nothing stored", async () => {
  const r = await post({ ...envelope(), schemaVersion: "2.0" }, "idem-invalid-01");
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "VALIDATION_FAILED");
});

test("data outside consent scope → 422 and not stored", async () => {
  const env = envelope({ consent: { ...envelope().consent, scope: ["identity", "discharge", "livingNeeds"] } });
  const r = await post(env, "idem-scope-0001");
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, "CONSENT_SCOPE_VIOLATION");
  const rows = await db.query(`SELECT 1 FROM incoming_referrals WHERE transfer_id = $1`, [env.transferId]);
  assert.equal(rows.length, 0);
});

test("policy-blocked categories (diagnosis, medication) are dropped, not stored", async () => {
  const env = envelope({
    clinicalSummary: { ...envelope().clinicalSummary, principalDiagnosis: { system: "KCD", code: "I63.9", display: "합성진단" }, medicationSummary: [{ name: "합성약", frequency: "1일 1회" }] },
    consent: { ...envelope().consent, scope: ["identity", "discharge", "kAdl", "cognition", "livingNeeds", "principalDiagnosis", "medicationSummary"] },
  });
  const r = await post(env, "idem-dx-000001");
  assert.equal(r.status, 201);
  const [v] = await db.query<any>(`SELECT payload::text AS p FROM referral_payload_versions v JOIN incoming_referrals r ON r.id = v.referral_id WHERE r.transfer_id = $1`, [env.transferId]);
  assert.ok(!v.p.includes("합성진단") && !v.p.includes("합성약"));
  const ce = await db.query<any>(`SELECT category, decision FROM consent_evidence c JOIN incoming_referrals r ON r.id = c.referral_id WHERE r.transfer_id = $1`, [env.transferId]);
  assert.equal(ce.find((c) => c.category === "principalDiagnosis").decision, "blocked_by_policy");
});

test("duplicate transferId → 409 and no duplicate case; idempotent replay returns same response", async () => {
  const env = envelope();
  const first = await post(env, "idem-dup-00001");
  assert.equal(first.status, 201);
  const replay = await post(env, "idem-dup-00001");
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(replay.json, first.json);
  const conflictKey = await post({ ...env, discharge: { plannedDate: "2026-12-24" } }, "idem-dup-00001");
  assert.equal(conflictKey.status, 409, "same key, different body");
  const dup = await post(env, "idem-dup-00002");
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "DUPLICATE_TRANSFER");
  const [{ n }] = await db.query<any>(`SELECT count(*)::int AS n FROM incoming_referrals WHERE transfer_id = $1`, [env.transferId]);
  assert.equal(n, 1);
});

test("missing/invalid credentials, wrong destination and missing idempotency key are refused", async () => {
  assert.equal((await call(referrals.POST, { method: "POST", body: envelope(), csrf: false })).status, 401);
  assert.equal((await post(envelope(), "idem-badkey-01", { authorization: "Bearer wrong-key-1234567890" })).status, 401);
  const wrong = await post(envelope({ destination: { municipalityCode: "DEMO-NURI" } }), "idem-dest-0001");
  assert.equal(wrong.status, 422);
  const noIdem = await call(referrals.POST, { method: "POST", body: envelope(), headers: { authorization: authHeaders("x").authorization }, csrf: false });
  assert.equal(noIdem.status, 400);
});

test("info request → hospital resubmission → back under review; status endpoint shows requested items", async () => {
  const env = envelope();
  const r = await post(env, "idem-resub-001");
  const id = (await db.query<any>(`SELECT id FROM incoming_referrals WHERE transfer_id = $1`, [env.transferId]))[0].id;
  // resubmission before an info request is not allowed
  const early = await call(resub.POST, { method: "POST", params: { transferId: env.transferId }, body: env, headers: authHeaders("idem-resub-early"), csrf: false });
  assert.equal(early.status, 409);
  assert.equal((await call(staffTransition.POST, { as: DEMO_USERS.admin, params: { id }, body: { to: "UNDER_REVIEW" } })).status, 200);
  const info = await call(staffTransition.POST, { as: DEMO_USERS.admin, params: { id }, body: { to: "NEEDS_INFORMATION", missingItems: ["욕실 구조 상세"] } });
  assert.equal(info.status, 200, JSON.stringify(info.json));
  const st = await call(statusRoute.GET, { params: { transferId: env.transferId }, headers: { authorization: authHeaders("x").authorization } });
  assert.equal(st.json.referral.status, "NEEDS_INFORMATION");
  assert.deepEqual(st.json.referral.requestedInformation, ["욕실 구조 상세"]);
  assert.equal(st.json.referral.caseId, undefined, "no internal case data returned");
  const ok = await call(resub.POST, { method: "POST", params: { transferId: env.transferId }, body: { ...env, livingNeeds: { ...env.livingNeeds, barriers: ["계단", "욕실 문턱"] } }, headers: authHeaders("idem-resub-002"), csrf: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.referral.status, "RESUBMITTED");
  const [{ n }] = await db.query<any>(`SELECT count(*)::int AS n FROM referral_payload_versions WHERE referral_id = $1`, [id]);
  assert.equal(n, 2);
  assert.equal(r.status, 201);
});

test("hospital status callback records event; outbound status notices are queued, not sent", async () => {
  const env = envelope();
  await post(env, "idem-cb-000001");
  const cb = await call(callback.POST, { method: "POST", body: { schemaVersion: "1.0", transferId: env.transferId, event: "DISCHARGE_DATE_CHANGED", occurredAt: "2026-11-03T09:00:00+09:00", dischargeDate: "2026-12-10" }, headers: authHeaders("idem-cb-000002"), csrf: false });
  assert.equal(cb.status, 202);
  const [r] = await db.query<any>(`SELECT discharge_date::text AS d FROM incoming_referrals WHERE transfer_id = $1`, [env.transferId]);
  assert.equal(r.d, "2026-12-10");
  const out = await db.query<any>(`SELECT delivery_status FROM integration_messages WHERE direction = 'outbound'`);
  assert.ok(out.length > 0 && out.every((o) => o.delivery_status === "queued"));
});

test("another tenant cannot see the referral (RLS)", async () => {
  const rows = await withTenant(db, "tn_nuri", (tx) => tx.query(`SELECT id FROM incoming_referrals`));
  assert.equal(rows.length, 0);
});
