/**
 * 통합 관제 — staff side (docs/CONTROL_DASHBOARD.md).
 *  overview:  subjects in the actor's region scope with an exclusive status, location view (current vs designated),
 *             latest consented reading, KPIs, alert feed, today's service visits and field staff load.
 *  actions:   designated location, location consent register/withdraw, alert status, dispatch request/status.
 * Provider and auditor roles never reach this (staff-only, assertCaseRead/Write). Audit rows carry metadata only.
 */
import { z } from "zod";
import {
  DISPATCH_TRANSITIONS, READING_FRESH_MINUTES, SERVICE_GROUPS, SUBJECT_STATUSES, classifySubject, resolveLocation, serviceGroupOf,
  type DispatchStatus, type LocationView, type SubjectStatus,
} from "../../domain/control";
import { profileOf } from "../../domain/devices";
import { SIGNAL_RULES, baselineFor, type DailySummary } from "../../domain/wearable";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead, assertCaseWrite, isAdmin, isStaff, regionScopeSql } from "../authz";
import type { Db } from "../db/client";
import { newId } from "../db/ids";
import { badTransition, conflict, forbidden, invalid, notFound } from "../errors";
import { notify } from "./common";

const OPEN_CASE = `c.status NOT IN ('CLOSED', 'WITHDRAWN')`;
const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);

export type Subject = {
  caseId: string; caseCode: string; name: string; ageBand: string | null; region: string; regionId: string;
  workerId: string | null; workerName: string | null; status: SubjectStatus; location: LocationView;
  device: { kind: string; metrics: string[]; profile: string; profileLabel: string; realtime: boolean; location: boolean; fallSos: boolean; lastDailyAt: string | null; linked: boolean } | null;
  reading: { at: string; heartRate: number | null; bodyTempC: number | null; spo2: number | null; fresh: boolean } | null;
  openAlerts: { id: string; kind: string; severity: string; status: string; message: string; at: string }[];
  openSignals: number; services: string[]; visitInProgress: boolean;
  dispatch: { id: string; status: string; assigneeName: string } | null;
};

export async function controlOverview(tx: Db, actor: Actor, now = new Date()) {
  if (!isStaff(actor)) throw forbidden();
  const params: unknown[] = [];
  const scope = regionScopeSql(actor, "c.region_unit_id", params);
  const cases = await tx.query<any>(
    `SELECT c.id, c.case_code, c.region_unit_id, c.primary_worker_id, r.display_name, r.age_band, ru.name AS region, u.display_name AS worker_name
       FROM care_cases c JOIN care_recipients r ON r.id = c.recipient_id JOIN region_units ru ON ru.id = c.region_unit_id
       LEFT JOIN users u ON u.id = c.primary_worker_id
      WHERE ${OPEN_CASE} AND ${scope} ORDER BY c.case_code`,
    params,
  );
  const ids: string[] = cases.map((c) => c.id);
  const by = <T extends { case_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.case_id, [...(m.get(r.case_id) ?? []), r]);
    return m;
  };
  const q = <T>(sql: string) => tx.query<T & { case_id: string }>(sql, [ids]);

  const [designated, consents, fixes, devices, readings, alerts, signals, services, visits, dispatches] = await Promise.all([
    q<any>(`SELECT case_id, label, latitude, longitude FROM care_locations WHERE case_id = ANY($1)`),
    q<any>(`SELECT case_id FROM location_consents WHERE status = 'active' AND case_id = ANY($1)`),
    q<any>(`SELECT DISTINCT ON (case_id) case_id, latitude, longitude, accuracy_m, measured_at FROM location_fixes WHERE case_id = ANY($1) ORDER BY case_id, measured_at DESC`),
    q<any>(`SELECT d.case_id, d.device_kind, d.device_profile, d.last_received_at, w.metrics FROM wearable_devices d JOIN wearable_consents w ON w.id = d.consent_id
             WHERE d.status = 'active' AND w.status = 'active' AND d.case_id = ANY($1)`),
    q<any>(`SELECT DISTINCT ON (case_id) case_id, measured_at, heart_rate, body_temp_c, spo2 FROM wearable_readings
             WHERE case_id = ANY($1) AND (heart_rate IS NOT NULL OR body_temp_c IS NOT NULL OR spo2 IS NOT NULL) ORDER BY case_id, measured_at DESC`),
    q<any>(`SELECT id, case_id, kind, severity, status, message, opened_at FROM control_alerts WHERE status <> 'resolved' AND case_id = ANY($1) ORDER BY opened_at DESC`),
    q<any>(`SELECT case_id, signal_type, message, created_at, id FROM wearable_signals WHERE status = 'open' AND case_id = ANY($1) ORDER BY created_at DESC`),
    q<any>(`SELECT case_id, service_type, status FROM service_referrals WHERE status IN ('SCHEDULED', 'STARTED') AND case_id = ANY($1)`),
    q<any>(`SELECT v.case_id, v.id, v.service_type, v.status, v.scheduled_at, v.provider_id, p.name AS provider_name FROM service_visits v
             JOIN service_providers p ON p.id = v.provider_id WHERE v.case_id = ANY($1) AND v.scheduled_at::date = current_date`),
    q<any>(`SELECT f.id, f.case_id, f.status, f.assignee_id, f.requested_at, u.display_name AS assignee_name FROM field_dispatches f
             JOIN users u ON u.id = f.assignee_id WHERE f.case_id = ANY($1) AND (f.status IN ('requested','accepted','on_site') OR f.requested_at::date = current_date)`),
  ]);
  const [mDes, mFix, mDev, mRead, mAl, mSig, mSvc, mVis, mDis] = [designated, fixes, devices, readings, alerts, signals, services, visits, dispatches].map(by);
  const consentSet = new Set(consents.map((c) => c.case_id));

  const subjects: Subject[] = cases.map((c) => {
    const dev = mDev.get(c.id)?.[0] ?? null;
    const metrics: string[] = dev?.metrics ?? [];
    const rd = mRead.get(c.id)?.[0];
    const fresh = rd ? now.getTime() - new Date(rd.measured_at).getTime() <= READING_FRESH_MINUTES * 60_000 : false;
    const profile = dev ? profileOf(dev.device_profile) : null;
    // Daily-sync devices (e.g. SIGRING100) never send real-time readings: judge them by daily summary arrival instead,
    // so they are not flagged "갱신 지연" all the time. Missing summaries surface as the no_data signal.
    const dailyFresh = dev?.last_received_at ? now.getTime() - new Date(dev.last_received_at).getTime() <= SIGNAL_RULES.noDataHours * 3_600_000 : false;
    const linked = profile ? (profile.realtimeReadings ? fresh : dailyFresh) : false;
    const al = mAl.get(c.id) ?? [];
    const des = mDes.get(c.id)?.[0];
    const fx = mFix.get(c.id)?.[0];
    const vis = mVis.get(c.id) ?? [];
    const activeDispatch = (mDis.get(c.id) ?? []).find((d) => ["requested", "accepted", "on_site"].includes(d.status));
    const openSignals = mSig.get(c.id)?.length ?? 0;
    const visitInProgress = vis.some((v) => v.status === "in_progress");
    return {
      caseId: c.id, caseCode: c.case_code, name: c.display_name, ageBand: c.age_band, region: c.region, regionId: c.region_unit_id,
      workerId: c.primary_worker_id, workerName: c.worker_name,
      status: classifySubject({
        hasDevice: Boolean(dev), readingFresh: profile && !profile.realtimeReadings ? true : fresh, openUrgentAlerts: al.filter((a) => a.severity === "urgent").length,
        openCautionAlerts: al.filter((a) => a.severity === "caution").length, openWearableSignals: openSignals, visitInProgress,
      }),
      location: resolveLocation({
        consentActive: consentSet.has(c.id),
        fix: fx ? { lat: fx.latitude, lng: fx.longitude, accuracyM: fx.accuracy_m, at: iso(fx.measured_at)! } : null,
        designated: des ? { lat: des.latitude, lng: des.longitude, label: des.label } : null,
      }, now),
      device: dev && profile ? {
        kind: dev.device_kind, metrics, profile: profile.id, profileLabel: profile.label, realtime: profile.realtimeReadings, location: profile.location,
        fallSos: (profile.metrics as readonly string[]).includes("sos"), lastDailyAt: iso(dev.last_received_at), linked,
      } : null,
      // Only consented categories are shown (intake already rejects the rest; this guards withdrawn categories).
      reading: rd && dev ? {
        at: iso(rd.measured_at)!, fresh,
        heartRate: metrics.includes("heart_rate") ? rd.heart_rate : null,
        bodyTempC: metrics.includes("temperature") ? rd.body_temp_c : null,
        spo2: metrics.includes("spo2") ? rd.spo2 : null,
      } : null,
      openAlerts: al.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, status: a.status, message: a.message, at: iso(a.opened_at)! })),
      openSignals,
      services: [...new Set((mSvc.get(c.id) ?? []).map((s) => s.service_type as string))],
      visitInProgress,
      dispatch: activeDispatch ? { id: activeDispatch.id, status: activeDispatch.status, assigneeName: activeDispatch.assignee_name } : null,
    };
  });

  const count = (s: SubjectStatus) => subjects.filter((x) => x.status === s).length;
  const monitored = subjects.filter((s) => s.device?.linked).length;
  const statusCounts = Object.fromEntries(SUBJECT_STATUSES.map((s) => [s, count(s)])) as Record<SubjectStatus, number>;

  const subjectOf = new Map(subjects.map((s) => [s.caseId, s]));
  const feed = [
    ...alerts.map((a) => ({ id: a.id, source: "alert" as const, caseId: a.case_id, severity: a.severity as "urgent" | "caution", status: a.status as string, message: a.message as string, at: iso(a.opened_at)! })),
    // Daily-summary signals: one row per case (latest message + count), so one person cannot flood the feed.
    ...[...mSig.entries()].map(([caseId, rows]) => ({
      id: rows[0].id as string, source: "signal" as const, caseId, severity: "caution" as const, status: "open",
      message: `${rows[0].message as string}${rows.length > 1 ? ` 외 ${rows.length - 1}건 (웨어러블 일 요약)` : " (웨어러블 일 요약)"}`, at: iso(rows[0].created_at)!,
    })),
  ]
    .map((f) => ({ ...f, name: subjectOf.get(f.caseId)?.name ?? "", ageBand: subjectOf.get(f.caseId)?.ageBand ?? null, caseCode: subjectOf.get(f.caseId)?.caseCode ?? "" }))
    .sort((a, b) => (a.severity === b.severity ? b.at.localeCompare(a.at) : a.severity === "urgent" ? -1 : 1));

  const serviceGroups = SERVICE_GROUPS.map((g) => {
    const v = visits.filter((x) => serviceGroupOf(x.service_type) === g.key);
    return { key: g.key, label: g.label, total: v.length, inProgress: v.filter((x) => x.status === "in_progress").length, completed: v.filter((x) => x.status === "completed").length };
  });

  // Field staff: case managers whose scope overlaps the actor's (admin: all; case manager: only self).
  const staffRows = await tx.query<any>(
    `SELECT u.id, u.display_name, array_remove(array_agg(DISTINCT s.region_unit_id), NULL) AS regions
       FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'case_manager'
       LEFT JOIN user_region_scopes s ON s.user_id = u.id
      WHERE u.is_active AND ($1::boolean OR u.id = $2) GROUP BY u.id, u.display_name ORDER BY u.display_name`,
    [isAdmin(actor), actor.id],
  );
  const staff = staffRows.map((u) => {
    const mine = subjects.filter((s) => s.workerId === u.id);
    const ds = dispatches.filter((d) => d.assignee_id === u.id);
    return {
      id: u.id as string, name: u.display_name as string, regions: u.regions as string[],
      subjects: mine.length, urgent: mine.filter((s) => s.status === "urgent").length, caution: mine.filter((s) => s.status === "caution").length,
      activeDispatches: ds.filter((d) => ["requested", "accepted", "on_site"].includes(d.status)).length,
      completedToday: ds.filter((d) => d.status === "completed").length,
    };
  });
  const providerVisits = Object.values(
    visits.reduce<Record<string, { provider: string; scheduled: number; inProgress: number; completed: number; missed: number }>>((acc, v) => {
      const k = v.provider_id as string;
      acc[k] ??= { provider: v.provider_name, scheduled: 0, inProgress: 0, completed: 0, missed: 0 };
      const key = v.status === "in_progress" ? "inProgress" : (v.status as "scheduled" | "completed" | "missed");
      acc[k][key]++;
      return acc;
    }, {}),
  );

  // 아침 안부 요약: daily-sync (ring) wearers — latest day vs the person's own usual (Sigring-style "평소 대비").
  const dailyIds = subjects.filter((s) => s.device && !s.device.realtime).map((s) => s.caseId);
  const history = dailyIds.length ? await tx.query<DailySummary & { case_id: string }>(
    `SELECT case_id, to_char(summary_date, 'YYYY-MM-DD') AS date, wear_minutes AS "wearMinutes", steps, sleep_minutes AS "sleepMinutes",
            resting_heart_rate AS "restingHeartRate", hrv_rmssd AS "hrvRmssd", skin_temp_dev_c AS "skinTempDeviationC", stress_index AS "stressIndex", vitality_score AS "vitalityScore"
       FROM wearable_daily_summaries WHERE case_id = ANY($1) AND summary_date >= current_date - 15 ORDER BY summary_date`, [dailyIds]) : [];
  const morning = dailyIds.map((id) => {
    const s = subjectOf.get(id)!;
    const rows = history.filter((h) => h.case_id === id);
    const last = rows[rows.length - 1] ?? null;
    const base = last ? baselineFor(rows, last.date) : null;
    return {
      caseId: id, name: s.name, ageBand: s.ageBand, region: s.region, profileLabel: s.device!.profileLabel, status: s.status, openSignals: s.openSignals,
      date: last?.date ?? null, vitality: last?.vitalityScore ?? null, vitalityUsual: base?.vitalityScore ?? null,
      sleepMinutes: last?.sleepMinutes ?? null, sleepUsual: base?.sleepMinutes ?? null, steps: last?.steps ?? null, stepsUsual: base?.steps ?? null,
      skinTempDeviationC: last?.skinTempDeviationC ?? null,
    };
  }).sort((a, b) => b.openSignals - a.openSignals || (a.vitality ?? 100) - (b.vitality ?? 100));

  await audit(tx, actor, "control.view", { type: "control" }, "success", {
    subjects: subjects.length, currentLocationsShown: subjects.filter((s) => s.location.mode === "current").length,
  });

  return {
    asOf: now.toISOString(), subjects, statusCounts, feed, serviceGroups, staff, providerVisits, morning,
    dispatches: dispatches.map((d) => ({
      id: d.id as string, caseId: d.case_id as string, caseCode: subjectOf.get(d.case_id)?.caseCode ?? "", name: subjectOf.get(d.case_id)?.name ?? "",
      status: d.status as string, assigneeId: d.assignee_id as string, assigneeName: d.assignee_name as string, at: iso(d.requested_at)!,
    })),
    kpis: {
      total: subjects.length, monitored, caution: statusCounts.caution, urgent: statusCounts.urgent,
      servicesActive: services.filter((s) => s.status === "STARTED").length,
      visitsToday: visits.length + dispatches.filter((d) => new Date(d.requested_at).toDateString() === now.toDateString()).length,
    },
  };
}
export type ControlOverview = Awaited<ReturnType<typeof controlOverview>>;

/* ------------------------------------------------------------------ */
/* Location settings                                                   */
/* ------------------------------------------------------------------ */

export const designatedBody = z.object({
  label: z.string().trim().min(2).max(120),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
}).strict();

export async function setDesignatedLocation(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof designatedBody>) {
  await assertCaseWrite(tx, actor, caseId);
  await tx.query(
    `INSERT INTO care_locations (id, tenant_id, case_id, label, latitude, longitude, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, case_id) DO UPDATE SET label = EXCLUDED.label, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       recorded_by = EXCLUDED.recorded_by, updated_at = now()`,
    [newId("cloc"), actor.tenantId, caseId, b.label, b.latitude, b.longitude, actor.id],
  );
  await audit(tx, actor, "location.designated_update", { type: "case", id: caseId });
  return { ok: true };
}

export const locationConsentBody = z.object({
  legalBasis: z.string().trim().min(2).max(200),
  consentRecordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  retentionHours: z.coerce.number().int().min(1).max(720),
  separateConsentConfirmed: z.literal(true, { error: "위치정보 수집·이용 별도 동의서를 확인해야 합니다." }),
}).strict();

export async function registerLocationConsent(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof locationConsentBody>) {
  await assertCaseWrite(tx, actor, caseId);
  if (b.consentRecordedAt > new Date().toISOString().slice(0, 10)) throw invalid("동의 일자는 미래일 수 없습니다.");
  const [dev] = await tx.query<{ device_profile: string }>(`SELECT device_profile FROM wearable_devices WHERE case_id = $1 AND status = 'active'`, [caseId]);
  if (!dev) throw invalid("위치를 보낼 등록 기기가 없습니다. 웨어러블 기기를 먼저 등록하세요.");
  if (!profileOf(dev.device_profile).location) throw invalid(`${profileOf(dev.device_profile).label}은(는) 위치(GPS) 기능이 없어 실시간 위치를 수집할 수 없습니다. 지정 위치만 사용합니다.`);
  const [active] = await tx.query(`SELECT 1 FROM location_consents WHERE case_id = $1 AND status = 'active'`, [caseId]);
  if (active) throw conflict("이미 유효한 위치정보 동의가 있습니다.");
  const id = newId("lcn");
  await tx.query(
    `INSERT INTO location_consents (id, tenant_id, case_id, legal_basis, consent_recorded_at, retention_hours, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, actor.tenantId, caseId, b.legalBasis, b.consentRecordedAt, b.retentionHours, actor.id],
  );
  await audit(tx, actor, "location.consent_register", { type: "case", id: caseId }, "success", { retentionHours: b.retentionHours });
  return { id };
}

export async function withdrawLocationConsent(tx: Db, actor: Actor, caseId: string) {
  await assertCaseWrite(tx, actor, caseId);
  const rows = await tx.query(`UPDATE location_consents SET status = 'withdrawn', withdrawn_at = now() WHERE case_id = $1 AND status = 'active' RETURNING id`, [caseId]);
  if (!rows.length) throw notFound("유효한 위치정보 동의");
  await audit(tx, actor, "location.consent_withdraw", { type: "case", id: caseId });
  return { ok: true };
}

export async function getLocationSettings(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  const [designated] = await tx.query<any>(`SELECT label, latitude, longitude, updated_at FROM care_locations WHERE case_id = $1`, [caseId]);
  const [consent] = await tx.query<any>(
    `SELECT status, legal_basis, consent_recorded_at, retention_hours, withdrawn_at FROM location_consents WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, [caseId]);
  const [fix] = await tx.query<any>(`SELECT measured_at FROM location_fixes WHERE case_id = $1 ORDER BY measured_at DESC LIMIT 1`, [caseId]);
  return { designated: designated ?? null, consent: consent ?? null, lastFixAt: fix ? iso(fix.measured_at) : null };
}

/* ------------------------------------------------------------------ */
/* Alerts and dispatches                                               */
/* ------------------------------------------------------------------ */

export const alertUpdateBody = z.object({ status: z.enum(["in_progress", "resolved"]), note: z.string().trim().max(500).optional().default("") }).strict()
  .refine((b) => b.status !== "resolved" || b.note.length >= 2, { message: "종결할 때는 확인 내용을 적어야 합니다.", path: ["note"] });

export async function updateAlert(tx: Db, actor: Actor, alertId: string, b: z.infer<typeof alertUpdateBody>) {
  const [a] = await tx.query<{ case_id: string; status: string }>(`SELECT case_id, status FROM control_alerts WHERE id = $1 FOR UPDATE`, [alertId]);
  if (!a) throw notFound("알림");
  await assertCaseWrite(tx, actor, a.case_id);
  if (a.status === "resolved") throw badTransition(a.status, b.status);
  await tx.query(`UPDATE control_alerts SET status = $2, note = $3, handled_by = $4, handled_at = now() WHERE id = $1`, [alertId, b.status, b.note, actor.id]);
  await audit(tx, actor, "control.alert_update", { type: "control_alert", id: alertId }, "success", { from: a.status, to: b.status });
  return { ok: true };
}

export const dispatchBody = z.object({
  reason: z.string().trim().min(2).max(300),
  assigneeId: z.string().min(1).optional(),
  alertId: z.string().min(1).optional(),
}).strict();

/** 현장 출동요청: a field visit request to a case manager covering the case region (default: the primary worker). */
export async function requestDispatch(tx: Db, actor: Actor, caseId: string, b: z.infer<typeof dispatchBody>) {
  const c = await assertCaseWrite(tx, actor, caseId);
  const [cc] = await tx.query<{ primary_worker_id: string | null; case_code: string }>(`SELECT primary_worker_id, case_code FROM care_cases WHERE id = $1`, [caseId]);
  const assignee = b.assigneeId ?? cc.primary_worker_id;
  if (!assignee) throw invalid("출동할 담당자를 지정하세요.");
  const [ok] = await tx.query(
    `SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'case_manager'
       JOIN user_region_scopes s ON s.user_id = u.id AND s.region_unit_id = $2 WHERE u.id = $1 AND u.is_active`,
    [assignee, c.region_unit_id],
  );
  if (!ok) throw invalid("해당 권역을 담당하는 활성 사례관리자에게만 출동을 요청할 수 있습니다.");
  if (b.alertId) {
    const [al] = await tx.query<{ case_id: string; status: string }>(`SELECT case_id, status FROM control_alerts WHERE id = $1 FOR UPDATE`, [b.alertId]);
    if (!al || al.case_id !== caseId) throw notFound("알림");
    if (al.status === "open") await tx.query(`UPDATE control_alerts SET status = 'in_progress', handled_by = $2, handled_at = now() WHERE id = $1`, [b.alertId, actor.id]);
  }
  const [active] = await tx.query(`SELECT 1 FROM field_dispatches WHERE case_id = $1 AND status IN ('requested','accepted','on_site')`, [caseId]);
  if (active) throw conflict("이미 진행 중인 출동요청이 있습니다.");
  const id = newId("fdp");
  await tx.query(
    `INSERT INTO field_dispatches (id, tenant_id, case_id, alert_id, requested_by, assignee_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, actor.tenantId, caseId, b.alertId ?? null, actor.id, assignee, b.reason],
  );
  await notify(tx, actor.tenantId, assignee, "field_dispatch", `${cc.case_code} 현장 출동요청`, `/control?focus=${caseId}`);
  await audit(tx, actor, "control.dispatch_request", { type: "field_dispatch", id }, "success", { caseId, linkedAlert: Boolean(b.alertId) });
  return { id };
}

export const dispatchUpdateBody = z.object({ status: z.enum(["accepted", "on_site", "completed", "cancelled"]), note: z.string().trim().max(500).optional().default("") }).strict();

/** The assignee moves the dispatch along; an admin may also cancel. */
export async function updateDispatch(tx: Db, actor: Actor, dispatchId: string, b: z.infer<typeof dispatchUpdateBody>) {
  const [d] = await tx.query<{ case_id: string; status: DispatchStatus; assignee_id: string }>(`SELECT case_id, status, assignee_id FROM field_dispatches WHERE id = $1 FOR UPDATE`, [dispatchId]);
  if (!d) throw notFound("출동요청");
  await assertCaseRead(tx, actor, d.case_id);
  const mayAct = d.assignee_id === actor.id || (isAdmin(actor) && b.status === "cancelled");
  if (!mayAct) throw forbidden("배정된 담당자만 출동 상태를 바꿀 수 있습니다.");
  if (!DISPATCH_TRANSITIONS[d.status].includes(b.status)) throw badTransition(d.status, b.status);
  const col = { accepted: "accepted_at", on_site: "arrived_at", completed: "closed_at", cancelled: "closed_at" }[b.status];
  await tx.query(`UPDATE field_dispatches SET status = $2, ${col} = now(), note = CASE WHEN $3 = '' THEN note ELSE $3 END WHERE id = $1`, [dispatchId, b.status, b.note]);
  if (b.status === "on_site" || b.status === "completed") await tx.query(`UPDATE care_cases SET last_contact_at = now() WHERE id = $1`, [d.case_id]);
  await audit(tx, actor, "control.dispatch_update", { type: "field_dispatch", id: dispatchId }, "success", { from: d.status, to: b.status });
  return { ok: true };
}

/** Case managers who may receive a dispatch, per region (for the popup selector). */
export async function dispatchCandidates(tx: Db) {
  const rows = await tx.query<{ region_unit_id: string; id: string; display_name: string }>(
    `SELECT s.region_unit_id, u.id, u.display_name FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'case_manager'
       JOIN user_region_scopes s ON s.user_id = u.id WHERE u.is_active ORDER BY u.display_name`,
  );
  const out: Record<string, { id: string; name: string }[]> = {};
  for (const r of rows) (out[r.region_unit_id] ??= []).push({ id: r.id, name: r.display_name });
  return out;
}
