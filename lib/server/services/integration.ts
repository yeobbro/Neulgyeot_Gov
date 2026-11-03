/**
 * System-to-system Hospital → Municipality referral intake.
 *
 * Authentication here is a DEMO bearer API key per hospital client
 * (hashed at rest, scoped). A production integration would replace it with
 * the mechanism agreed with each municipality (e.g. OAuth 2.0 client
 * credentials, mTLS, request signing) — see docs/INTEGRATION_WITH_HOSPITAL.md.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { evaluateConsent, minimizePayload, type IntakePolicy } from "../../integrations/hospital/consent-scope";
import {
  referralEnvelopeSchema,
  statusCallbackSchema,
  type ReferralEnvelope,
  type TransferCategory,
} from "../../integrations/hospital/schema";
import { REFERRAL_STATUS_LABEL, REFERRAL_TRANSITIONS, canTransition, type ReferralStatus } from "../../domain/enums";
import { audit } from "../audit";
import { withTenant, type Db } from "../db/client";
import { newId, nextNo } from "../db/ids";
import { AppError } from "../errors";
import { addTask } from "./common";

export type IntegrationClient = { id: string; tenantId: string; tenantCode: string; sourceOrgCode: string; sourceOrgName: string; scopes: string[] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function authenticateClient(db: Db, authHeader: string | null, scope: string): Promise<IntegrationClient> {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,200})$/.exec(authHeader ?? "");
  if (!m) throw new AppError("unauthenticated", "연계 인증 정보가 없습니다.");
  // Owner connection: the tenant is not known until the client is identified.
  const [c] = await db.query<{ id: string; tenant_id: string; code: string; source_org_code: string; source_org_name: string; scopes: string[]; is_active: boolean }>(
    `SELECT c.id, c.tenant_id, t.code, c.source_org_code, c.source_org_name, c.scopes, c.is_active
       FROM integration_clients c JOIN tenants t ON t.id = c.tenant_id WHERE c.key_hash = $1`,
    [sha(m[1])],
  );
  if (!c || !c.is_active) throw new AppError("unauthenticated", "연계 인증에 실패했습니다.");
  if (!c.scopes.includes(scope)) throw new AppError("forbidden", "이 연계 작업에 대한 권한(scope)이 없습니다.");
  return { id: c.id, tenantId: c.tenant_id, tenantCode: c.code, sourceOrgCode: c.source_org_code, sourceOrgName: c.source_org_name, scopes: c.scopes };
}

type Outcome = { status: number; body: Record<string, unknown> };

/** Idempotency: same key + same body → stored response; same key + different body → 409. */
async function withIdempotency(tx: Db, tenantId: string, key: string | null, requestBody: unknown, fn: () => Promise<Outcome>): Promise<Outcome & { replayed: boolean }> {
  if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    throw new AppError("validation_error", "Idempotency-Key 헤더(8~100자)가 필요합니다.");
  }
  const hash = sha(JSON.stringify(requestBody ?? null));
  const [prev] = await tx.query<{ request_hash: string; response_status: number; response_body: Record<string, unknown> }>(
    `SELECT request_hash, response_status, response_body FROM idempotency_records WHERE tenant_id = $1 AND idem_key = $2`,
    [tenantId, key],
  );
  if (prev) {
    if (prev.request_hash !== hash) throw new AppError("conflict", "같은 Idempotency-Key로 다른 요청 본문이 전송되었습니다.");
    return { status: prev.response_status, body: prev.response_body, replayed: true };
  }
  const out = await fn();
  await tx.query(
    `INSERT INTO idempotency_records (tenant_id, idem_key, request_hash, response_status, response_body) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, key, hash, out.status, JSON.stringify(out.body)],
  );
  return { ...out, replayed: false };
}

async function logMessage(tx: Db, tenantId: string, kind: string, client: IntegrationClient, transferId: string | null, traceId: string | null, httpStatus: number, errorCode: string | null) {
  await tx.query(
    `INSERT INTO integration_messages (id, tenant_id, direction, kind, transfer_id, trace_id, client_id, http_status, error_code) VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7,$8)`,
    [newId("im"), tenantId, kind, transferId, traceId, client.id, httpStatus, errorCode],
  );
}

/** Queue an outbound status notice to the hospital (mock adapter: never sent over the network). */
async function queueOutboundStatus(tx: Db, tenantId: string, transferId: string, traceId: string, status: ReferralStatus) {
  await tx.query(
    `INSERT INTO integration_messages (id, tenant_id, direction, kind, transfer_id, trace_id, http_status, delivery_status) VALUES ($1,$2,'outbound',$3,$4,$5,NULL,'queued')`,
    [newId("im"), tenantId, `status:${status}`, transferId, traceId],
  );
}
export { queueOutboundStatus };

function publicStatus(r: { transfer_id: string; receipt_no: string; status: ReferralStatus; missing_items: string[]; decline_reason: string | null; updated_at: string | Date; trace_id: string }) {
  // Limited status only — no internal case data is returned to the hospital.
  return {
    transferId: r.transfer_id,
    receiptNo: r.receipt_no,
    status: r.status,
    statusLabel: REFERRAL_STATUS_LABEL[r.status],
    requestedInformation: r.status === "NEEDS_INFORMATION" ? r.missing_items : [],
    declineReason: r.status === "DECLINED" ? r.decline_reason : null,
    updatedAt: new Date(r.updated_at).toISOString(),
    traceId: r.trace_id,
  };
}

async function loadPolicy(tx: Db, tenantId: string): Promise<IntakePolicy> {
  const [s] = await tx.query<{ intake_allowed_categories: TransferCategory[] }>(`SELECT intake_allowed_categories FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
  return { allowedCategories: s?.intake_allowed_categories ?? [] };
}

function parseEnvelope(body: unknown): { env: ReferralEnvelope | null; issues: { path: string; message: string }[] } {
  const r = referralEnvelopeSchema.safeParse(body);
  if (r.success) return { env: r.data, issues: [] };
  return { env: null, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

const subjectRef = (sourceOrg: string, patientId: string) => `EXT-${sha(`${sourceOrg}:${patientId}`).slice(0, 12)}`;

async function storeVersion(tx: Db, tenantId: string, referralId: string, versionNo: number, env: ReferralEnvelope, evaluation: ReturnType<typeof evaluateConsent>) {
  const payload = minimizePayload(env, evaluation);
  const vid = newId("rpv");
  await tx.query(
    `INSERT INTO referral_payload_versions (id, tenant_id, referral_id, version_no, payload, payload_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
    [vid, tenantId, referralId, versionNo, JSON.stringify(payload), sha(JSON.stringify(payload))],
  );
  for (const d of evaluation.decisions) {
    await tx.query(
      `INSERT INTO consent_evidence (id, tenant_id, referral_id, payload_version_id, category, sensitive, decision, reason, purpose, retention, legal_basis, separate_consent_status, consent_recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [newId("ce"), tenantId, referralId, vid, d.category, d.sensitive, d.decision, d.reason, env.consent.purpose ?? null, env.consent.retention, env.consent.legalBasis ?? null, env.consent.sensitiveInformationConsent, env.consent.recordedAt],
    );
  }
  return { vid, payload };
}

/** POST /api/integrations/hospital/referrals */
export async function receiveReferral(db: Db, client: IntegrationClient, body: unknown, idemKey: string | null, traceHeader: string | null) {
  return withTenant(db, client.tenantId, async (tx) => {
    const res = await withIdempotency(tx, client.tenantId, idemKey, body, async (): Promise<Outcome> => {
      const { env, issues } = parseEnvelope(body);
      const traceId = (env?.traceId ?? traceHeader ?? newId("trace")).slice(0, 80);
      if (!env) {
        await logMessage(tx, client.tenantId, "referral.create", client, null, traceId, 400, "schema_invalid");
        await audit(tx, null, "referral.reject", { type: "integration_client", id: client.id }, "failure", { reason: "schema_invalid", issues: issues.length }, client.tenantId);
        return { status: 400, body: { error: { code: "VALIDATION_FAILED", message: "연계 데이터 형식 검증에 실패했습니다.", issues }, traceId } };
      }
      if (env.destination.municipalityCode !== client.tenantCode) {
        await logMessage(tx, client.tenantId, "referral.create", client, env.transferId, traceId, 422, "wrong_destination");
        return { status: 422, body: { error: { code: "WRONG_DESTINATION", message: "수신 지자체 코드가 인증된 연계 대상과 일치하지 않습니다." }, traceId } };
      }
      if (env.source.facilityId !== client.sourceOrgCode) {
        await logMessage(tx, client.tenantId, "referral.create", client, env.transferId, traceId, 422, "source_mismatch");
        return { status: 422, body: { error: { code: "SOURCE_MISMATCH", message: "송신 기관 코드가 인증 정보와 일치하지 않습니다." }, traceId } };
      }
      const [dup] = await tx.query<{ id: string; transfer_id: string; receipt_no: string; status: ReferralStatus; missing_items: string[]; decline_reason: string | null; updated_at: string; trace_id: string }>(
        `SELECT id, transfer_id, receipt_no, status, missing_items, decline_reason, updated_at, trace_id FROM incoming_referrals WHERE transfer_id = $1`,
        [env.transferId],
      );
      if (dup) {
        await logMessage(tx, client.tenantId, "referral.create", client, env.transferId, traceId, 409, "duplicate_transfer");
        await audit(tx, null, "referral.duplicate", { type: "incoming_referral", id: dup.id }, "failure", {}, client.tenantId);
        return { status: 409, body: { error: { code: "DUPLICATE_TRANSFER", message: "이미 접수된 transferId입니다. 보완 제출은 resubmissions 엔드포인트를 사용하세요." }, referral: publicStatus(dup), traceId } };
      }
      const evaluation = evaluateConsent(env, await loadPolicy(tx, client.tenantId));
      if (!evaluation.ok) {
        // Not stored: payload outside the consent/legal scope is rejected entirely.
        await logMessage(tx, client.tenantId, "referral.create", client, env.transferId, traceId, 422, "consent_scope");
        await audit(tx, null, "referral.reject", { type: "integration_client", id: client.id }, "failure", { reason: "consent_scope", issues: evaluation.errors.length }, client.tenantId);
        return { status: 422, body: { error: { code: "CONSENT_SCOPE_VIOLATION", message: "동의·법적 근거 범위를 벗어난 항목이 포함되어 수신하지 않았습니다.", issues: evaluation.errors }, traceId } };
      }

      const id = newId("ir");
      const receiptNo = await nextNo(tx, client.tenantId, "REF");
      const pending = evaluation.decisions.some((d) => d.decision === "pending_review");
      const missing: string[] = [];
      if (!env.discharge?.plannedDate) missing.push("퇴원 예정일");
      if (!env.livingNeeds) missing.push("생활환경·요청 서비스");
      const [row] = await tx.query<{ id: string; transfer_id: string; receipt_no: string; status: ReferralStatus; missing_items: string[]; decline_reason: string | null; updated_at: string; trace_id: string }>(
        `INSERT INTO incoming_referrals (id, tenant_id, transfer_id, receipt_no, source_org_code, source_org_name, discharge_date, subject_ref, subject_display,
           requested_services, status, consent_check_status, schema_version, trace_id, validation, missing_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RECEIVED',$11,$12,$13,$14,$15)
         RETURNING id, transfer_id, receipt_no, status, missing_items, decline_reason, updated_at, trace_id`,
        [
          id, client.tenantId, env.transferId, receiptNo, client.sourceOrgCode, client.sourceOrgName, env.discharge?.plannedDate ?? null,
          subjectRef(client.sourceOrgCode, env.subject.patientId), `연계대상 ${receiptNo.slice(-4)}`, env.livingNeeds?.requestedServices ?? [],
          pending ? "pending_review" : "verified", env.schemaVersion, traceId,
          JSON.stringify({ ok: true, issues: [], decisions: evaluation.decisions.map((d) => ({ category: d.category, decision: d.decision })) }), missing,
        ],
      );
      const { vid } = await storeVersion(tx, client.tenantId, id, 1, env, evaluation);
      // Direct identifiers are held for possible case creation, separated from the referral list.
      await tx.query(
        `INSERT INTO referral_events (id, tenant_id, referral_id, from_status, to_status, actor_label, note) VALUES ($1,$2,$3,NULL,'RECEIVED','시스템 (병원 연계 수신)',$4)`,
        [newId("re"), client.tenantId, id, `스키마 v${env.schemaVersion} 검증 통과 · 저장 버전 ${vid}`],
      );
      await pendingIdentityStore(tx, client.tenantId, id, env);
      await addTask(tx, client.tenantId, { referralId: id, type: "referral_review", title: `${receiptNo} 병원 연계 신청 검토`, dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) });
      await logMessage(tx, client.tenantId, "referral.create", client, env.transferId, traceId, 201, null);
      await audit(tx, null, "referral.receive", { type: "incoming_referral", id }, "success", { pendingReview: pending, categories: evaluation.decisions.length }, client.tenantId);
      return { status: 201, body: { referral: publicStatus(row), traceId } };
    });
    return res;
  });
}

/**
 * Direct identifiers (name, birth date) are kept in an encrypted-at-rest
 * store in production; in this MVP they are stored in recipient_identities
 * only when a case is created. Until then they live in a separate column
 * of the payload version that the referral list never selects.
 */
async function pendingIdentityStore(tx: Db, tenantId: string, referralId: string, env: ReferralEnvelope) {
  await tx.query(
    `UPDATE referral_payload_versions SET payload = payload || jsonb_build_object('_identity', jsonb_build_object('name', $3::text, 'birthDate', $4::text))
      WHERE tenant_id = $1 AND referral_id = $2 AND version_no = (SELECT max(version_no) FROM referral_payload_versions WHERE referral_id = $2)`,
    [tenantId, referralId, env.subject.name, env.subject.birthDate],
  );
}

/** GET /api/integrations/hospital/referrals/{transferId} — limited status for the sending hospital. */
export async function getReferralStatusForClient(db: Db, client: IntegrationClient, transferId: string) {
  return withTenant(db, client.tenantId, async (tx) => {
    const [r] = await tx.query<{ transfer_id: string; receipt_no: string; status: ReferralStatus; missing_items: string[]; decline_reason: string | null; updated_at: string; trace_id: string; source_org_code: string }>(
      `SELECT transfer_id, receipt_no, status, missing_items, decline_reason, updated_at, trace_id, source_org_code FROM incoming_referrals WHERE transfer_id = $1`,
      [transferId],
    );
    if (!r || r.source_org_code !== client.sourceOrgCode) throw new AppError("not_found", "연계 건을 찾을 수 없습니다.");
    await logMessage(tx, client.tenantId, "referral.status", client, transferId, r.trace_id, 200, null);
    return { referral: publicStatus(r) };
  });
}

/** POST /api/integrations/hospital/referrals/{transferId}/resubmissions */
export async function resubmitReferral(db: Db, client: IntegrationClient, transferId: string, body: unknown, idemKey: string | null) {
  return withTenant(db, client.tenantId, async (tx) =>
    withIdempotency(tx, client.tenantId, idemKey, { transferId, body }, async (): Promise<Outcome> => {
      const [r] = await tx.query<{ id: string; status: ReferralStatus; source_org_code: string; trace_id: string }>(
        `SELECT id, status, source_org_code, trace_id FROM incoming_referrals WHERE transfer_id = $1 FOR UPDATE`,
        [transferId],
      );
      if (!r || r.source_org_code !== client.sourceOrgCode) return { status: 404, body: { error: { code: "NOT_FOUND", message: "연계 건을 찾을 수 없습니다." } } };
      if (!canTransition(REFERRAL_TRANSITIONS, r.status, "RESUBMITTED")) {
        return { status: 409, body: { error: { code: "INVALID_STATE", message: `현재 상태(${REFERRAL_STATUS_LABEL[r.status]})에서는 보완 제출할 수 없습니다.` } } };
      }
      const { env, issues } = parseEnvelope(body);
      if (!env || env.transferId !== transferId) {
        return { status: 400, body: { error: { code: "VALIDATION_FAILED", message: "보완 데이터 형식 검증에 실패했습니다.", issues: env ? [{ path: "transferId", message: "transferId 불일치" }] : issues } } };
      }
      const evaluation = evaluateConsent(env, await loadPolicy(tx, client.tenantId));
      if (!evaluation.ok) return { status: 422, body: { error: { code: "CONSENT_SCOPE_VIOLATION", message: "동의 범위를 벗어난 항목이 포함되어 수신하지 않았습니다.", issues: evaluation.errors } } };
      const [{ n }] = await tx.query<{ n: number }>(`SELECT coalesce(max(version_no),0)::int AS n FROM referral_payload_versions WHERE referral_id = $1`, [r.id]);
      await storeVersion(tx, client.tenantId, r.id, n + 1, env, evaluation);
      await pendingIdentityStore(tx, client.tenantId, r.id, env);
      const missing: string[] = [];
      if (!env.discharge?.plannedDate) missing.push("퇴원 예정일");
      const [row] = await tx.query<{ transfer_id: string; receipt_no: string; status: ReferralStatus; missing_items: string[]; decline_reason: string | null; updated_at: string; trace_id: string; assigned_user_id: string | null }>(
        `UPDATE incoming_referrals SET status = 'RESUBMITTED', missing_items = $2, discharge_date = $3, requested_services = $4, updated_at = now()
          WHERE id = $1 RETURNING transfer_id, receipt_no, status, missing_items, decline_reason, updated_at, trace_id, assigned_user_id`,
        [r.id, missing, env.discharge?.plannedDate ?? null, env.livingNeeds?.requestedServices ?? []],
      );
      await tx.query(
        `INSERT INTO referral_events (id, tenant_id, referral_id, from_status, to_status, actor_label, note) VALUES ($1,$2,$3,$4,'RESUBMITTED','시스템 (병원 보완 제출)',$5)`,
        [newId("re"), client.tenantId, r.id, r.status, `보완 버전 v${n + 1} 수신`],
      );
      await addTask(tx, client.tenantId, { referralId: r.id, type: "info_request_followup", title: `${row.receipt_no} 보완 자료 확인`, assigneeId: row.assigned_user_id });
      await logMessage(tx, client.tenantId, "referral.resubmit", client, transferId, r.trace_id, 200, null);
      await audit(tx, null, "referral.resubmit", { type: "incoming_referral", id: r.id }, "success", { version: n + 1 }, client.tenantId);
      return { status: 200, body: { referral: publicStatus(row) } };
    }),
  );
}

/** POST /api/integrations/hospital/callbacks/status — hospital-side events (withdrawal, discharge date change). */
export async function hospitalStatusCallback(db: Db, client: IntegrationClient, body: unknown, idemKey: string | null) {
  return withTenant(db, client.tenantId, async (tx) =>
    withIdempotency(tx, client.tenantId, idemKey, body, async (): Promise<Outcome> => {
      const parsed = statusCallbackSchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: { code: "VALIDATION_FAILED", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } } };
      const cb = parsed.data;
      const [r] = await tx.query<{ id: string; status: ReferralStatus; source_org_code: string; trace_id: string; assigned_user_id: string | null }>(
        `SELECT id, status, source_org_code, trace_id, assigned_user_id FROM incoming_referrals WHERE transfer_id = $1 FOR UPDATE`,
        [cb.transferId],
      );
      if (!r || r.source_org_code !== client.sourceOrgCode) return { status: 404, body: { error: { code: "NOT_FOUND" } } };
      let note = "";
      if (cb.event === "DISCHARGE_DATE_CHANGED") {
        await tx.query(`UPDATE incoming_referrals SET discharge_date = $2, updated_at = now() WHERE id = $1`, [r.id, cb.dischargeDate ?? null]);
        note = `퇴원 예정일 변경 통지: ${cb.dischargeDate ?? "미정"}`;
      } else if (cb.event === "REFERRAL_WITHDRAWN") {
        note = "병원 측 연계 철회 통지 — 담당자 확인 후 종결 처리 필요";
        await addTask(tx, client.tenantId, { referralId: r.id, type: "referral_review", title: "병원 연계 철회 통지 확인", assigneeId: r.assigned_user_id });
      } else note = "퇴원 완료 통지";
      await tx.query(
        `INSERT INTO referral_events (id, tenant_id, referral_id, from_status, to_status, actor_label, note) VALUES ($1,$2,$3,$4,$4,'시스템 (병원 상태 통지)',$5)`,
        [newId("re"), client.tenantId, r.id, r.status, note],
      );
      await logMessage(tx, client.tenantId, `callback:${cb.event}`, client, cb.transferId, r.trace_id, 202, null);
      await audit(tx, null, "referral.callback", { type: "incoming_referral", id: r.id }, "success", { event: cb.event }, client.tenantId);
      return { status: 202, body: { accepted: true, transferId: cb.transferId, event: cb.event } };
    }),
  );
}

export const integrationHeadersSchema = z.object({ idempotencyKey: z.string().nullable(), traceId: z.string().nullable() });
