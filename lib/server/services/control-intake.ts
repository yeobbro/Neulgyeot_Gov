/**
 * Gateway intake for the control view (docs/CONTROL_DASHBOARD.md):
 *  - readings:  near-real-time vital snapshots + fall/SOS events (scope wearables:write), consent-category checked
 *  - locations: current position fixes (scope locations:write), accepted ONLY with an active location consent
 * Rejected payloads are never partially stored. Audit rows carry metadata only (no values, no coordinates).
 */
import { z } from "zod";
import { ALERT_SEVERITY, alertMessage, evaluateReading, READING_EVENTS, type AlertKind, type Reading } from "../../domain/control";
import { profileOf } from "../../domain/devices";
import { audit } from "../audit";
import { withTenant, type Db } from "../db/client";
import { newId } from "../db/ids";
import type { IntegrationClient } from "./integration";
import { notify } from "./common";

export const LOCATION_SCOPE = "locations:write";

type Outcome = { status: number; body: Record<string, unknown> };
const traceOf = (h: string | null) => (h && /^[A-Za-z0-9._:-]{4,80}$/.test(h) ? h : newId("trace")).slice(0, 80);

async function logIntake(tx: Db, client: IntegrationClient, kind: string, traceId: string, httpStatus: number, errorCode: string | null) {
  await tx.query(
    `INSERT INTO integration_messages (id, tenant_id, direction, kind, trace_id, client_id, http_status, error_code) VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7)`,
    [newId("im"), client.tenantId, kind, traceId, client.id, httpStatus, errorCode],
  );
}

const err = (status: number, code: string, message: string, traceId: string, extra: Record<string, unknown> = {}): Outcome => ({
  status, body: { error: { code, message, ...extra }, traceId },
});

/** measuredAt must be a real timestamp, not in the future (+5 min clock skew) and not older than 24 h (real-time channel). */
const measuredAt = z.string().datetime({ offset: true }).refine((v) => {
  const t = Date.parse(v);
  return t <= Date.now() + 5 * 60_000 && t >= Date.now() - 86_400_000;
}, "측정 시각은 최근 24시간 이내여야 하며 미래일 수 없습니다.");

const readingSchema = z
  .object({
    measuredAt,
    heartRate: z.number().int().min(20).max(250).nullable().optional(),
    bodyTempC: z.number().min(30).max(45).nullable().optional(),
    spo2: z.number().int().min(50).max(100).nullable().optional(),
    event: z.enum(READING_EVENTS).nullable().optional(),
  })
  .strict()
  .refine((r) => r.heartRate != null || r.bodyTempC != null || r.spo2 != null || r.event != null, "값이 하나도 없는 측정은 받을 수 없습니다.");

export const readingsBody = z.object({ schemaVersion: z.literal("0.1"), deviceRef: z.string().regex(/^[A-Za-z0-9._:-]{4,64}$/), readings: z.array(readingSchema).min(1).max(120) }).strict();

const fixSchema = z
  .object({ measuredAt, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracyM: z.number().int().min(0).max(10_000).nullable().optional() })
  .strict();
export const locationsBody = z.object({ schemaVersion: z.literal("0.1"), deviceRef: z.string().regex(/^[A-Za-z0-9._:-]{4,64}$/), fixes: z.array(fixSchema).min(1).max(60) }).strict();

type Device = { id: string; case_id: string; status: string; consent_status: string; metrics: string[]; device_profile: string };
async function findDevice(tx: Db, client: IntegrationClient, deviceRef: string): Promise<Device | undefined> {
  const [d] = await tx.query<Device>(
    `SELECT d.id, d.case_id, d.status, c.status AS consent_status, c.metrics, d.device_profile
       FROM wearable_devices d JOIN wearable_consents c ON c.id = d.consent_id WHERE d.client_id = $1 AND d.device_ref = $2`,
    [client.id, deviceRef],
  );
  return d;
}

const READING_FIELD_METRIC = { heartRate: "heart_rate", bodyTempC: "temperature", spo2: "spo2" } as const;
export function readingFieldsOutsideConsent(r: Reading, granted: readonly string[]): string[] {
  const out: string[] = (Object.keys(READING_FIELD_METRIC) as (keyof typeof READING_FIELD_METRIC)[]).filter((f) => r[f] != null && !granted.includes(READING_FIELD_METRIC[f]));
  if (r.event && !granted.includes(r.event)) out.push(`event:${r.event}`);
  return out;
}

/** Raise or refresh the single open alert of (case, kind). Returns true when a new alert was opened. */
export async function raiseAlert(tx: Db, tenantId: string, caseId: string, deviceId: string | null, kind: AlertKind, message: string): Promise<boolean> {
  const [open] = await tx.query<{ id: string }>(`SELECT id FROM control_alerts WHERE case_id = $1 AND kind = $2 AND status <> 'resolved' FOR UPDATE`, [caseId, kind]);
  if (open) {
    await tx.query(`UPDATE control_alerts SET message = $2, last_seen_at = now() WHERE id = $1`, [open.id, message]);
    return false;
  }
  await tx.query(
    `INSERT INTO control_alerts (id, tenant_id, case_id, device_id, kind, severity, message) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId("cal"), tenantId, caseId, deviceId, kind, ALERT_SEVERITY[kind], message],
  );
  if (ALERT_SEVERITY[kind] === "urgent") {
    const [c] = await tx.query<{ primary_worker_id: string | null; case_code: string }>(`SELECT primary_worker_id, case_code FROM care_cases WHERE id = $1`, [caseId]);
    await notify(tx, tenantId, c?.primary_worker_id, "control_alert", `${c?.case_code ?? ""} 즉시 확인 필요 알림`, `/control?focus=${caseId}`);
  }
  return true;
}

/** POST /api/integrations/wearables/readings */
export async function receiveReadings(db: Db, client: IntegrationClient, body: unknown, traceHeader: string | null): Promise<Outcome> {
  const traceId = traceOf(traceHeader);
  const KIND = "wearable.readings";
  return withTenant(db, client.tenantId, async (tx) => {
    const parsed = readingsBody.safeParse(body);
    if (!parsed.success) {
      await logIntake(tx, client, KIND, traceId, 400, "schema_invalid");
      return err(400, "VALIDATION_FAILED", "측정값 형식 검증에 실패했습니다.", traceId, { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const b = parsed.data;
    const dev = await findDevice(tx, client, b.deviceRef);
    if (!dev) {
      await logIntake(tx, client, KIND, traceId, 404, "device_not_registered");
      return err(404, "DEVICE_NOT_REGISTERED", "등록되지 않은 기기입니다.", traceId);
    }
    if (dev.status !== "active" || dev.consent_status !== "active") {
      await logIntake(tx, client, KIND, traceId, 422, "consent_not_active");
      await audit(tx, null, "wearable.readings_intake", { type: "wearable_device", id: dev.id }, "failure", { reason: "consent_not_active" }, client.tenantId);
      return err(422, "CONSENT_NOT_ACTIVE", "동의가 철회되었거나 일시중지된 기기입니다. 수신하지 않았습니다.", traceId);
    }
    const outside = [...new Set(b.readings.flatMap((r) => readingFieldsOutsideConsent(r, dev.metrics)))];
    if (outside.length) {
      await logIntake(tx, client, KIND, traceId, 422, "consent_scope");
      await audit(tx, null, "wearable.readings_intake", { type: "wearable_device", id: dev.id }, "failure", { reason: "consent_scope", fields: outside }, client.tenantId);
      return err(422, "CONSENT_SCOPE_VIOLATION", "동의하지 않은 항목이 포함되어 수신하지 않았습니다.", traceId, { fields: outside });
    }

    let stored = 0;
    for (const r of b.readings) {
      const rows = await tx.query(
        `INSERT INTO wearable_readings (id, tenant_id, case_id, device_id, measured_at, heart_rate, body_temp_c, spo2, event)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, device_id, measured_at) DO NOTHING RETURNING id`,
        [newId("wrd"), client.tenantId, dev.case_id, dev.id, r.measuredAt, r.heartRate ?? null, r.bodyTempC ?? null, r.spo2 ?? null, r.event ?? null],
      );
      stored += rows.length;
    }

    // Events from any reading; vital ranges from the most recent reading only (an old value is not "current").
    let alertsOpened = 0;
    const sorted = [...b.readings].sort((x, y) => Date.parse(x.measuredAt) - Date.parse(y.measuredAt));
    for (const ev of new Set(sorted.flatMap((r) => (r.event ? [r.event] : [])))) if (await raiseAlert(tx, client.tenantId, dev.case_id, dev.id, ev, alertMessage(ev))) alertsOpened++;
    const latest = evaluateReading(sorted[sorted.length - 1]);
    if (latest.vital && (await raiseAlert(tx, client.tenantId, dev.case_id, dev.id, latest.vital.kind, alertMessage(latest.vital.kind, latest.vital.parts)))) alertsOpened++;

    await logIntake(tx, client, KIND, traceId, 200, null);
    await audit(tx, null, "wearable.readings_intake", { type: "wearable_device", id: dev.id }, "success", { accepted: b.readings.length, stored, alertsOpened }, client.tenantId);
    return { status: 200, body: { accepted: b.readings.length, stored, alertsOpened, traceId } };
  });
}

/** POST /api/integrations/locations */
export async function receiveLocations(db: Db, client: IntegrationClient, body: unknown, traceHeader: string | null): Promise<Outcome> {
  const traceId = traceOf(traceHeader);
  const KIND = "location.fixes";
  return withTenant(db, client.tenantId, async (tx) => {
    const parsed = locationsBody.safeParse(body);
    if (!parsed.success) {
      await logIntake(tx, client, KIND, traceId, 400, "schema_invalid");
      return err(400, "VALIDATION_FAILED", "위치 형식 검증에 실패했습니다.", traceId, { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const b = parsed.data;
    const dev = await findDevice(tx, client, b.deviceRef);
    if (!dev) {
      await logIntake(tx, client, KIND, traceId, 404, "device_not_registered");
      return err(404, "DEVICE_NOT_REGISTERED", "등록되지 않은 기기입니다.", traceId);
    }
    if (!profileOf(dev.device_profile).location) {
      await logIntake(tx, client, KIND, traceId, 422, "device_no_location");
      return err(422, "DEVICE_HAS_NO_LOCATION", "위치 기능이 없는 기기 프로필입니다. 위치를 저장하지 않았습니다.", traceId);
    }
    const [lc] = await tx.query<{ id: string }>(`SELECT id FROM location_consents WHERE case_id = $1 AND status = 'active'`, [dev.case_id]);
    if (dev.status !== "active" || !lc) {
      await logIntake(tx, client, KIND, traceId, 422, "location_consent_not_active");
      await audit(tx, null, "location.intake", { type: "wearable_device", id: dev.id }, "failure", { reason: "location_consent_not_active" }, client.tenantId);
      return err(422, "LOCATION_CONSENT_NOT_ACTIVE", "위치정보 수집 동의가 없거나 철회되어 위치를 저장하지 않았습니다.", traceId);
    }
    let stored = 0;
    for (const f of b.fixes) {
      const rows = await tx.query(
        `INSERT INTO location_fixes (id, tenant_id, case_id, device_id, latitude, longitude, accuracy_m, measured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, device_id, measured_at) DO NOTHING RETURNING id`,
        [newId("lfx"), client.tenantId, dev.case_id, dev.id, f.latitude, f.longitude, f.accuracyM ?? null, f.measuredAt],
      );
      stored += rows.length;
    }
    await logIntake(tx, client, KIND, traceId, 200, null);
    await audit(tx, null, "location.intake", { type: "wearable_device", id: dev.id }, "success", { accepted: b.fixes.length, stored }, client.tenantId);
    return { status: 200, body: { accepted: b.fixes.length, stored, traceId } };
  });
}
