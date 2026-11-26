/**
 * Wearable integration (Phase 0) — see docs/WEARABLE_INTEGRATION.md.
 *
 *  Gateway side:  receiveDailySummaries — authenticated integration client (scope wearables:write), consent-scope check,
 *                 per-(device, day) upsert, explainable signals, one open `wearable_check` task per case.
 *  Staff side:    overview, device + consent registration, consent withdrawal, signal review.
 *
 * Not an emergency path and not a diagnosis: signals are "확인 필요" items for the case manager. Audit rows carry
 * metadata only (no values, no notes). Provider and auditor roles never see wearable data (assertCaseRead).
 */
import { z } from "zod";
import {
  DEVICE_KINDS, SIGNAL_DUE_DAYS, WEARABLE_METRICS, WEARABLE_METRIC_LABEL, evaluateDay, fieldsOutsideConsent, noDataSignal,
  type DailySummary, type Signal, type SignalType, type WearableMetric,
} from "../../domain/wearable";
import { DEVICE_PROFILE_IDS, defaultProfileFor, profileOf, unsupportedMetrics, type DeviceProfileId } from "../../domain/devices";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead, assertCaseWrite } from "../authz";
import { withTenant, type Db } from "../db/client";
import { newId } from "../db/ids";
import { conflict, invalid, notFound } from "../errors";
import type { IntegrationClient } from "./integration";
import { addDays, addTask, notify } from "./common";

export const WEARABLE_SCOPE = "wearables:write";

/* ------------------------------------------------------------------ */
/* Gateway intake                                                      */
/* ------------------------------------------------------------------ */

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const opt = (min: number, max: number) => int(min, max).nullable().optional();
const summarySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    wearMinutes: int(0, 1440),
    steps: opt(0, 200_000),
    activeMinutes: opt(0, 1440),
    sleepMinutes: opt(0, 1440),
    restingHeartRate: opt(20, 250),
    heartRateMin: opt(20, 250),
    heartRateMax: opt(20, 250),
    spo2Min: opt(50, 100),
    fallEvents: opt(0, 100),
    sosEvents: opt(0, 100),
    // contract 0.2 — ring-type metrics (docs/SIGRING_INTEGRATION.md)
    sleepDeepMinutes: opt(0, 1440),
    sleepRemMinutes: opt(0, 1440),
    hrvRmssd: opt(1, 300),
    skinTempDeviationC: z.number().min(-5).max(5).nullable().optional(),
    stressIndex: opt(0, 100),
    vitalityScore: opt(0, 100),
  })
  .strict();
const V02_FIELDS = ["sleepDeepMinutes", "sleepRemMinutes", "hrvRmssd", "skinTempDeviationC", "stressIndex", "vitalityScore"] as const; // unknown fields (e.g. location, raw streams) are rejected, not silently dropped

export const dailySummariesBody = z
  .object({
    schemaVersion: z.enum(["0.1", "0.2"]),
    deviceRef: z.string().regex(/^[A-Za-z0-9._:-]{4,64}$/),
    summaries: z.array(summarySchema).min(1).max(31),
  })
  .strict()
  .superRefine((b, ctx) => {
    const tomorrow = addDays(1);
    const seen = new Set<string>();
    b.summaries.forEach((s, i) => {
      if (Number.isNaN(Date.parse(`${s.date}T00:00:00Z`))) ctx.addIssue({ code: "custom", path: ["summaries", i, "date"], message: "올바른 날짜가 아닙니다." });
      if (s.date > tomorrow) ctx.addIssue({ code: "custom", path: ["summaries", i, "date"], message: "미래 날짜의 요약은 받을 수 없습니다." });
      if (seen.has(s.date)) ctx.addIssue({ code: "custom", path: ["summaries", i, "date"], message: "같은 날짜가 중복되었습니다." });
      if (b.schemaVersion === "0.1") for (const f of V02_FIELDS) if (s[f] != null) ctx.addIssue({ code: "custom", path: ["summaries", i, f], message: "이 항목은 schemaVersion 0.2에서만 받을 수 있습니다." });
      seen.add(s.date);
    });
  });

type Outcome = { status: number; body: Record<string, unknown> };

async function logIntake(tx: Db, client: IntegrationClient, traceId: string, httpStatus: number, errorCode: string | null) {
  await tx.query(
    `INSERT INTO integration_messages (id, tenant_id, direction, kind, trace_id, client_id, http_status, error_code) VALUES ($1,$2,'inbound','wearable.daily_summaries',$3,$4,$5,$6)`,
    [newId("im"), client.tenantId, traceId, client.id, httpStatus, errorCode],
  );
}

type DeviceRow = { id: string; case_id: string; status: string; consent_status: string; metrics: string[]; paired_at: string | Date; last_received_at: string | Date | null };

const SUMMARY_COLS = `to_char(summary_date, 'YYYY-MM-DD') AS date, wear_minutes AS "wearMinutes", steps, active_minutes AS "activeMinutes", sleep_minutes AS "sleepMinutes",
  resting_heart_rate AS "restingHeartRate", heart_rate_min AS "heartRateMin", heart_rate_max AS "heartRateMax", spo2_min AS "spo2Min",
  fall_events AS "fallEvents", sos_events AS "sosEvents", sleep_deep_minutes AS "sleepDeepMinutes", sleep_rem_minutes AS "sleepRemMinutes",
  hrv_rmssd AS "hrvRmssd", skin_temp_dev_c AS "skinTempDeviationC", stress_index AS "stressIndex", vitality_score AS "vitalityScore"`;

/** POST /api/integrations/wearables/daily-summaries */
export async function receiveDailySummaries(db: Db, client: IntegrationClient, body: unknown, traceHeader: string | null): Promise<Outcome> {
  const traceId = (traceHeader && /^[A-Za-z0-9._:-]{4,80}$/.test(traceHeader) ? traceHeader : newId("trace")).slice(0, 80);
  return withTenant(db, client.tenantId, async (tx) => {
    const parsed = dailySummariesBody.safeParse(body);
    if (!parsed.success) {
      await logIntake(tx, client, traceId, 400, "schema_invalid");
      return { status: 400, body: { error: { code: "VALIDATION_FAILED", message: "웨어러블 요약 형식 검증에 실패했습니다.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, traceId } };
    }
    const b = parsed.data;
    const [dev] = await tx.query<DeviceRow>(
      `SELECT d.id, d.case_id, d.status, c.status AS consent_status, c.metrics, d.paired_at, d.last_received_at
         FROM wearable_devices d JOIN wearable_consents c ON c.id = d.consent_id
        WHERE d.client_id = $1 AND d.device_ref = $2 FOR UPDATE OF d`,
      [client.id, b.deviceRef],
    );
    if (!dev) {
      await logIntake(tx, client, traceId, 404, "device_not_registered");
      return { status: 404, body: { error: { code: "DEVICE_NOT_REGISTERED", message: "등록되지 않은 기기입니다. 담당자가 사례에 기기를 먼저 등록해야 합니다." }, traceId } };
    }
    if (dev.status !== "active" || dev.consent_status !== "active") {
      await logIntake(tx, client, traceId, 422, "consent_not_active");
      await audit(tx, null, "wearable.intake", { type: "wearable_device", id: dev.id }, "failure", { reason: "consent_not_active" }, client.tenantId);
      return { status: 422, body: { error: { code: "CONSENT_NOT_ACTIVE", message: "동의가 철회되었거나 일시중지된 기기입니다. 수신하지 않았습니다." }, traceId } };
    }
    const outside = [...new Set(b.summaries.flatMap((s) => fieldsOutsideConsent(s, dev.metrics)))];
    if (outside.length) {
      // Rejected entirely: data outside the consented categories is never stored.
      await logIntake(tx, client, traceId, 422, "consent_scope");
      await audit(tx, null, "wearable.intake", { type: "wearable_device", id: dev.id }, "failure", { reason: "consent_scope", fields: outside }, client.tenantId);
      return { status: 422, body: { error: { code: "CONSENT_SCOPE_VIOLATION", message: "동의하지 않은 항목이 포함되어 수신하지 않았습니다.", fields: outside }, traceId } };
    }

    for (const s of b.summaries) {
      await tx.query(
        `INSERT INTO wearable_daily_summaries (id, tenant_id, device_id, case_id, summary_date, wear_minutes, steps, active_minutes, sleep_minutes,
           resting_heart_rate, heart_rate_min, heart_rate_max, spo2_min, fall_events, sos_events,
           sleep_deep_minutes, sleep_rem_minutes, hrv_rmssd, skin_temp_dev_c, stress_index, vitality_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (tenant_id, device_id, summary_date) DO UPDATE SET
           wear_minutes = EXCLUDED.wear_minutes, steps = EXCLUDED.steps, active_minutes = EXCLUDED.active_minutes, sleep_minutes = EXCLUDED.sleep_minutes,
           resting_heart_rate = EXCLUDED.resting_heart_rate, heart_rate_min = EXCLUDED.heart_rate_min, heart_rate_max = EXCLUDED.heart_rate_max,
           spo2_min = EXCLUDED.spo2_min, fall_events = EXCLUDED.fall_events, sos_events = EXCLUDED.sos_events,
           sleep_deep_minutes = EXCLUDED.sleep_deep_minutes, sleep_rem_minutes = EXCLUDED.sleep_rem_minutes, hrv_rmssd = EXCLUDED.hrv_rmssd,
           skin_temp_dev_c = EXCLUDED.skin_temp_dev_c, stress_index = EXCLUDED.stress_index, vitality_score = EXCLUDED.vitality_score, received_at = now()`,
        [newId("wds"), client.tenantId, dev.id, dev.case_id, s.date, s.wearMinutes, s.steps ?? null, s.activeMinutes ?? null, s.sleepMinutes ?? null,
          s.restingHeartRate ?? null, s.heartRateMin ?? null, s.heartRateMax ?? null, s.spo2Min ?? null, s.fallEvents ?? null, s.sosEvents ?? null,
          s.sleepDeepMinutes ?? null, s.sleepRemMinutes ?? null, s.hrvRmssd ?? null, s.skinTempDeviationC ?? null, s.stressIndex ?? null, s.vitalityScore ?? null],
      );
    }
    await tx.query(`UPDATE wearable_devices SET last_received_at = now() WHERE id = $1`, [dev.id]);

    const oldest = b.summaries.map((s) => s.date).sort()[0];
    const history = await tx.query<DailySummary>(
      `SELECT ${SUMMARY_COLS} FROM wearable_daily_summaries WHERE device_id = $1 AND summary_date >= ($2::date - 15) ORDER BY summary_date`,
      [dev.id, oldest],
    );
    const signals = b.summaries.flatMap((s) => evaluateDay(history.find((h) => h.date === s.date) ?? s, history));
    const created = await storeSignals(tx, client.tenantId, dev.case_id, dev.id, signals);

    await logIntake(tx, client, traceId, 200, null);
    await audit(tx, null, "wearable.intake", { type: "wearable_device", id: dev.id }, "success", { accepted: b.summaries.length, signalsCreated: created }, client.tenantId);
    return { status: 200, body: { accepted: b.summaries.length, signalsCreated: created, traceId } };
  });
}

/** Insert new signals (a repeated day does not duplicate them) and attach them to the case's open wearable_check task. */
async function storeSignals(tx: Db, tenantId: string, caseId: string, deviceId: string, signals: Signal[]): Promise<number> {
  const ids: string[] = [];
  for (const s of signals) {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO wearable_signals (id, tenant_id, case_id, device_id, signal_type, signal_date, message, basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, device_id, signal_type, signal_date) DO NOTHING RETURNING id`,
      [newId("wsg"), tenantId, caseId, deviceId, s.type, s.date, s.message, JSON.stringify(s.basis)],
    );
    if (rows[0]) ids.push(rows[0].id);
  }
  if (!ids.length) return 0;
  const dueDays = Math.min(...signals.map((s) => SIGNAL_DUE_DAYS[s.type]));
  const taskId = await ensureCheckTask(tx, tenantId, caseId, addDays(dueDays));
  await tx.query(`UPDATE wearable_signals SET task_id = $2 WHERE id = ANY($1::text[])`, [ids, taskId]);
  return ids.length;
}

/** One open wearable_check task per case: reuse it (pulling its due date earlier if needed) instead of flooding the worker. */
async function ensureCheckTask(tx: Db, tenantId: string, caseId: string, dueAt: string): Promise<string> {
  const [open] = await tx.query<{ id: string }>(`SELECT id FROM action_tasks WHERE case_id = $1 AND task_type = 'wearable_check' AND status = 'open' LIMIT 1`, [caseId]);
  if (open) {
    await tx.query(`UPDATE action_tasks SET due_at = LEAST(due_at, $2::date) WHERE id = $1`, [open.id, dueAt]);
    return open.id;
  }
  const [c] = await tx.query<{ primary_worker_id: string | null; case_code: string }>(`SELECT primary_worker_id, case_code FROM care_cases WHERE id = $1`, [caseId]);
  const id = await addTask(tx, tenantId, { caseId, type: "wearable_check", title: `${c?.case_code ?? ""} 웨어러블 신호 확인`, dueAt, assigneeId: c?.primary_worker_id });
  await notify(tx, tenantId, c?.primary_worker_id, "wearable_check", `${c?.case_code ?? "사례"} 웨어러블 확인 필요 신호`, `/cases/${caseId}?tab=wearable`);
  return id;
}

/** Raise `no_data` for active devices that have gone quiet (idempotent: at most one open no_data signal per device). */
export async function refreshWearableGaps(tx: Db, tenantId: string, caseId?: string, now = new Date()): Promise<number> {
  const params: unknown[] = [];
  let where = `d.status = 'active' AND NOT EXISTS (SELECT 1 FROM wearable_signals s WHERE s.device_id = d.id AND s.signal_type = 'no_data' AND s.status = 'open')`;
  if (caseId) {
    params.push(caseId);
    where += ` AND d.case_id = $1`;
  }
  const devices = await tx.query<{ id: string; case_id: string; paired_at: string | Date; last_received_at: string | Date | null }>(
    `SELECT d.id, d.case_id, d.paired_at, d.last_received_at FROM wearable_devices d WHERE ${where}`,
    params,
  );
  let n = 0;
  for (const d of devices) {
    const s = noDataSignal(d.last_received_at ? new Date(d.last_received_at) : null, new Date(d.paired_at), now);
    if (s) n += await storeSignals(tx, tenantId, d.case_id, d.id, [s]);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Staff                                                               */
/* ------------------------------------------------------------------ */

export async function getWearableOverview(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  await refreshWearableGaps(tx, actor.tenantId, caseId);
  const consents = await tx.query<{ id: string; metrics: string[]; legal_basis: string; consent_recorded_at: string; retention_days: number; status: string; withdrawn_at: string | null }>(
    `SELECT id, metrics, legal_basis, consent_recorded_at, retention_days, status, withdrawn_at FROM wearable_consents WHERE case_id = $1 ORDER BY created_at DESC`,
    [caseId],
  );
  const devices = await tx.query<{ id: string; device_kind: string; device_profile: string; device_ref: string; model_label: string; status: string; paired_at: string; last_received_at: string | null; gateway_name: string; consent_id: string }>(
    `SELECT d.id, d.device_kind, d.device_profile, d.device_ref, d.model_label, d.status, d.paired_at, d.last_received_at, d.consent_id, ic.source_org_name AS gateway_name
       FROM wearable_devices d JOIN integration_clients ic ON ic.id = d.client_id WHERE d.case_id = $1 ORDER BY d.paired_at DESC`,
    [caseId],
  );
  const summaries = await tx.query<DailySummary & { deviceId: string }>(
    `SELECT device_id AS "deviceId", ${SUMMARY_COLS} FROM wearable_daily_summaries WHERE case_id = $1 AND summary_date >= current_date - 13 ORDER BY summary_date DESC`,
    [caseId],
  );
  const signals = await tx.query<{ id: string; signal_type: SignalType; signal_date: string; message: string; basis: Record<string, number>; status: string; review_note: string; reviewed_at: string | null; reviewer_name: string | null }>(
    `SELECT s.id, s.signal_type, to_char(s.signal_date, 'YYYY-MM-DD') AS signal_date, s.message, s.basis, s.status, s.review_note, s.reviewed_at, u.display_name AS reviewer_name
       FROM wearable_signals s LEFT JOIN users u ON u.id = s.reviewed_by
      WHERE s.case_id = $1 ORDER BY (s.status = 'open') DESC, s.signal_date DESC, s.created_at DESC LIMIT 50`,
    [caseId],
  );
  await audit(tx, actor, "wearable.view", { type: "case", id: caseId });
  return { consents, devices, summaries, signals };
}

/** Active integration clients that may send wearable summaries (registration form). */
export async function listWearableGateways(tx: Db) {
  return tx.query<{ id: string; source_org_name: string }>(
    `SELECT id, source_org_name FROM integration_clients WHERE is_active AND $1 = ANY(scopes) ORDER BY source_org_name`,
    [WEARABLE_SCOPE],
  );
}

export const registerDeviceBody = z.object({
  clientId: z.string().min(1).max(80),
  deviceKind: z.enum(DEVICE_KINDS),
  deviceProfile: z.enum(DEVICE_PROFILE_IDS as [DeviceProfileId, ...DeviceProfileId[]]).optional(),
  deviceRef: z.string().trim().regex(/^[A-Za-z0-9._:-]{4,64}$/, "기기 참조값은 영문·숫자·._:- 4~64자입니다."),
  modelLabel: z.string().trim().max(80).default(""),
  metrics: z.array(z.enum(WEARABLE_METRICS)).min(1).max(WEARABLE_METRICS.length),
  legalBasis: z.string().trim().min(2).max(200),
  consentRecordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/),
  retentionDays: z.number().int().min(1).max(1095).default(90),
  separateConsentConfirmed: z.literal(true, { message: "민감정보(건강) 항목별 별도 동의를 확인해야 등록할 수 있습니다." }),
});

export async function registerDevice(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof registerDeviceBody>) {
  await assertCaseWrite(tx, actor, caseId);
  if (!b.metrics.includes("wear")) throw invalid("착용 시간 항목은 필수입니다. (다른 항목을 해석하는 기준)");
  const profileId = b.deviceProfile ?? defaultProfileFor(b.deviceKind);
  const profile = profileOf(profileId);
  if (profile.kind !== b.deviceKind) throw invalid(`${profile.label}은(는) ${b.deviceKind === "smart_ring" ? "스마트워치" : "스마트링"} 프로필입니다. 기기 종류를 확인하세요.`);
  const unsupported = unsupportedMetrics(profileId, b.metrics);
  if (unsupported.length)
    throw invalid(`이 기기는 다음 항목을 측정하지 않습니다: ${unsupported.map((m) => WEARABLE_METRIC_LABEL[m as WearableMetric] ?? m).join(", ")}. 측정하지 않는 항목은 동의받지 않습니다.`, { unsupported });
  const [gw] = await tx.query<{ id: string }>(`SELECT id FROM integration_clients WHERE id = $1 AND is_active AND $2 = ANY(scopes)`, [b.clientId, WEARABLE_SCOPE]);
  if (!gw) throw invalid("웨어러블 수신이 허용된 연계 게이트웨이가 아닙니다.");
  const [active] = await tx.query(`SELECT 1 FROM wearable_devices WHERE case_id = $1 AND status = 'active'`, [caseId]);
  if (active) throw conflict("이미 사용 중인 기기가 있습니다. 기존 동의를 철회한 뒤 등록하세요.");
  const [dup] = await tx.query(`SELECT 1 FROM wearable_devices WHERE client_id = $1 AND device_ref = $2`, [b.clientId, b.deviceRef]);
  if (dup) throw conflict("이 게이트웨이에 이미 등록된 기기 참조값입니다.");
  const consentId = newId("wcn");
  const recordedAt = new Date(b.consentRecordedAt).toISOString();
  await tx.query(
    `INSERT INTO wearable_consents (id, tenant_id, case_id, metrics, legal_basis, consent_recorded_at, retention_days, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [consentId, actor.tenantId, caseId, b.metrics, b.legalBasis, recordedAt, b.retentionDays, actor.id],
  );
  const deviceId = newId("wdv");
  await tx.query(
    `INSERT INTO wearable_devices (id, tenant_id, case_id, consent_id, client_id, device_ref, device_kind, model_label, device_profile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [deviceId, actor.tenantId, caseId, consentId, b.clientId, b.deviceRef, b.deviceKind, b.modelLabel, profileId],
  );
  await audit(tx, actor, "wearable.register", { type: "wearable_device", id: deviceId }, "success", { deviceKind: b.deviceKind, deviceProfile: profileId, metrics: b.metrics, retentionDays: b.retentionDays });
  return { id: deviceId, consentId };
}

export async function withdrawConsent(tx: Db, actor: Actor, caseId: string) {
  await assertCaseWrite(tx, actor, caseId);
  const rows = await tx.query<{ id: string }>(`UPDATE wearable_consents SET status = 'withdrawn', withdrawn_at = now() WHERE case_id = $1 AND status = 'active' RETURNING id`, [caseId]);
  if (!rows.length) throw notFound("유효한 웨어러블 동의");
  await tx.query(`UPDATE wearable_devices SET status = 'paused' WHERE case_id = $1 AND status = 'active'`, [caseId]);
  await audit(tx, actor, "wearable.consent_withdraw", { type: "case", id: caseId }, "success", { consents: rows.length });
  return { ok: true };
}

export const reviewSignalBody = z.object({
  decision: z.enum(["acknowledged", "dismissed"]),
  note: z.string().trim().max(500).default(""),
});

export async function reviewSignal(tx: Db, actor: Actor, signalId: string, b: z.infer<typeof reviewSignalBody>) {
  const [s] = await tx.query<{ id: string; case_id: string; status: string; task_id: string | null }>(`SELECT id, case_id, status, task_id FROM wearable_signals WHERE id = $1`, [signalId]);
  if (!s) throw notFound("웨어러블 신호");
  await assertCaseWrite(tx, actor, s.case_id);
  if (s.status !== "open") throw conflict("이미 처리된 신호입니다.");
  if (b.decision === "dismissed" && b.note.length < 2) throw invalid("'해당 없음' 처리 사유를 입력해 주세요.");
  await tx.query(`UPDATE wearable_signals SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`, [signalId, b.decision, b.note, actor.id]);
  let taskClosed = false;
  if (s.task_id) {
    const [left] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM wearable_signals WHERE task_id = $1 AND status = 'open'`, [s.task_id]);
    if ((left?.n ?? 0) === 0) {
      await tx.query(`UPDATE action_tasks SET status = 'done', completed_at = now() WHERE id = $1 AND status = 'open'`, [s.task_id]);
      taskClosed = true;
    }
  }
  // Reviewing a signal is not a contact with the recipient: last_contact_at changes only through records/monitoring.
  await audit(tx, actor, "wearable.signal_review", { type: "wearable_signal", id: signalId }, "success", { decision: b.decision, taskClosed });
  return { ok: true, taskClosed };
}
