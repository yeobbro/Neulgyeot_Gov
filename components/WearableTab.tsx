import { Badge, Empty, Panel } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/client/ApiForm";
import {
  DEVICE_KINDS, DEVICE_KIND_LABEL, SIGNAL_LABEL, SIGNAL_STATUS_LABEL, WEARABLE_METRICS, WEARABLE_METRIC_LABEL,
  type DeviceKind, type SignalStatus, type SignalType, type WearableMetric,
} from "@/lib/domain/wearable";
import { DEVICE_PROFILES, DEVICE_PROFILE_IDS, profileOf } from "@/lib/domain/devices";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { getWearableOverview } from "@/lib/server/services/wearables";

type Overview = Awaited<ReturnType<typeof getWearableOverview>>;

const STATUS_TONE: Record<SignalStatus, "amber" | "green" | "gray"> = { open: "amber", acknowledged: "green", dismissed: "gray" };
const hm = (m: number | null | undefined) => (typeof m === "number" ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : "—");
const n = (v: number | null | undefined, unit = "") => (typeof v === "number" ? `${v.toLocaleString("ko-KR")}${unit}` : "—");

/** 사례 상세 → 웨어러블 탭. Staff only (the page itself is limited to admin / case manager). */
export function WearableTab({ caseId, data, gateways, canWrite }: { caseId: string; data: Overview; gateways: { id: string; source_org_name: string }[]; canWrite: boolean }) {
  const consent = data.consents.find((c) => c.status === "active") ?? null;
  const device = data.devices.find((d) => d.status === "active") ?? data.devices[0] ?? null;
  const granted = new Set(consent?.metrics ?? data.consents[0]?.metrics ?? []);
  const cell = (metric: WearableMetric, text: string) => (granted.has(metric) ? text : <span className="muted">미동의</span>);
  const open = data.signals.filter((s) => s.status === "open");
  const ringCols = ["vitality", "hrv", "skin_temp"].some((m) => granted.has(m as WearableMetric));

  return (
    <div className="stack">
      <div className="alert alert-warn" role="note">
        웨어러블 정보는 <strong>하루 단위 요약</strong>이며 늦게 도착할 수 있습니다. 응급 대응 경로가 아니고, 진단·응급 여부를 판단하지 않습니다.
        낙상·SOS 실시간 대응은 기기 사업자 관제·응급안전안심서비스·119 체계를 따릅니다. 모든 신호는 담당자 확인이 필요한 참고 정보입니다.
      </div>

      <div className="split">
        <Panel title={<>확인 필요 신호 {open.length > 0 && <Badge tone="amber">{open.length}건</Badge>}</>} id="wear-signals" note="평소(최근 14일 중앙값)와 비교한 근거를 함께 표시합니다.">
          {data.signals.length === 0 ? <Empty>신호 없음</Empty> : (
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="wearable-signals">
              {data.signals.map((s) => (
                <li key={s.id} style={{ borderBottom: "1px solid var(--line, #e5e7eb)", paddingBottom: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{SIGNAL_LABEL[s.signal_type as SignalType] ?? s.signal_type}</strong>
                    <span>{fmtDate(s.signal_date)} <Badge tone={STATUS_TONE[s.status as SignalStatus] ?? "gray"}>{SIGNAL_STATUS_LABEL[s.status as SignalStatus] ?? s.status}</Badge></span>
                  </div>
                  <p style={{ margin: "4px 0" }}>{s.message}</p>
                  {s.status !== "open" ? (
                    <small className="muted">{s.reviewer_name} · {fmtDateTime(s.reviewed_at)}{s.review_note ? ` · ${s.review_note}` : ""}</small>
                  ) : canWrite ? (
                    <ApiForm action={`/api/wearable-signals/${s.id}/review`} inline submitLabel="처리" successMessage="처리했습니다." testId={`wearable-review-${s.id}`} fields={[
                      { name: "decision", label: "처리", type: "select", required: true, defaultValue: "acknowledged", options: [{ value: "acknowledged", label: "확인 완료" }, { value: "dismissed", label: "해당 없음" }] },
                      { name: "note", label: "확인 내용", type: "text", maxLength: 500, placeholder: "예: 전화 확인, 감기로 외출 줄임" },
                    ]} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="동의·기기" id="wear-device" note="건강 관련 정보는 항목별 별도 동의(개인정보 보호법 제23조)가 있어야 수신합니다.">
          {device ? (
            <dl className="kv">
              <dt>기기</dt><dd>{DEVICE_KIND_LABEL[device.device_kind as DeviceKind]} · {device.model_label || "모델 미기재"} <Badge tone={device.status === "active" ? "green" : "gray"}>{device.status === "active" ? "수신 중" : "일시중지"}</Badge></dd>
              <dt>기기 프로필</dt><dd>{profileOf(device.device_profile).label}
                {profileOf(device.device_profile).notes.length > 0 && (
                  <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12 }}>{profileOf(device.device_profile).notes.map((t) => <li key={t}>{t}</li>)}</ul>
                )}</dd>
              <dt>기기 참조값</dt><dd><code>{device.device_ref}</code></dd>
              <dt>수집 게이트웨이</dt><dd>{device.gateway_name}</dd>
              <dt>마지막 수신</dt><dd>{device.last_received_at ? fmtDateTime(device.last_received_at) : "수신 기록 없음"}</dd>
              {consent ? (
                <>
                  <dt>동의 항목</dt><dd>{consent.metrics.map((m) => WEARABLE_METRIC_LABEL[m as WearableMetric] ?? m).join(", ")}</dd>
                  <dt>법적 근거</dt><dd>{consent.legal_basis}</dd>
                  <dt>동의 일시 · 보유</dt><dd>{fmtDate(consent.consent_recorded_at)} · {consent.retention_days}일</dd>
                </>
              ) : (
                <><dt>동의</dt><dd><Badge tone="gray">철회됨</Badge> {fmtDate(data.consents[0]?.withdrawn_at ?? null)}</dd></>
              )}
            </dl>
          ) : <Empty>등록된 기기 없음</Empty>}
          {canWrite && consent && (
            <div style={{ marginTop: 8 }}>
              <ActionButton action={`/api/cases/${caseId}/wearables/withdraw`} label="동의 철회 · 수신 중지" tone="danger" testId="wearable-withdraw" />
            </div>
          )}
          {canWrite && !consent && (
            gateways.length === 0 ? <p className="muted">웨어러블 수신이 허용된 연계 게이트웨이가 없습니다. 관리자에게 문의하세요.</p> : (
              <ApiForm action={`/api/cases/${caseId}/wearables`} submitLabel="기기 등록" successMessage="등록했습니다." testId="wearable-register" extra={{ retentionDays: 90 }} fields={[
                { name: "clientId", label: "수집 게이트웨이", type: "select", required: true, options: gateways.map((g) => ({ value: g.id, label: g.source_org_name })) },
                { name: "deviceKind", label: "기기 종류", type: "select", required: true, options: DEVICE_KINDS.map((k) => ({ value: k, label: DEVICE_KIND_LABEL[k] })) },
                { name: "deviceProfile", label: "기기 프로필", type: "select", required: true, help: "프로필이 측정하지 않는 항목은 동의 항목으로 고를 수 없습니다.",
                  options: DEVICE_PROFILE_IDS.map((id) => ({ value: id, label: `${DEVICE_PROFILES[id].label} — ${DEVICE_PROFILES[id].metrics.length}개 항목` })) },
                { name: "deviceRef", label: "기기 참조값", type: "text", required: true, maxLength: 64, help: "게이트웨이가 발급한 값" },
                { name: "modelLabel", label: "모델명", type: "text", maxLength: 80 },
                { name: "metrics", label: "동의 항목 (착용 시간 필수)", type: "checks", full: true, defaultValue: ["wear"], options: WEARABLE_METRICS.map((m) => ({ value: m, label: WEARABLE_METRIC_LABEL[m] })) },
                { name: "legalBasis", label: "법적 근거", type: "text", required: true, maxLength: 200, defaultValue: "정보주체 별도 동의(개인정보 보호법 제23조)" },
                { name: "consentRecordedAt", label: "동의 일자", type: "date", required: true },
                { name: "separateConsentConfirmed", label: "건강 관련 항목별 별도 동의서를 확인했습니다.", type: "checkbox", full: true },
              ]} />
            )
          )}
        </Panel>
      </div>

      <Panel title="최근 14일 요약" id="wear-days" note="'미동의'는 수신하지 않는 항목, '—'는 기기가 보내지 않은 값입니다.">
        {data.summaries.length === 0 ? <Empty>수신된 요약 없음</Empty> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
            <thead><tr><th scope="col">날짜</th><th scope="col">착용</th><th scope="col">걸음</th><th scope="col">활동</th><th scope="col">수면</th><th scope="col">안정 시 심박</th><th scope="col">최저 SpO₂</th>{ringCols && <><th scope="col">활력 지수</th><th scope="col">HRV</th><th scope="col">피부 온도</th></>}<th scope="col">낙상/SOS 기록</th></tr></thead>
            <tbody>{data.summaries.map((s) => (
              <tr key={`${s.deviceId}-${s.date}`}>
                <td>{s.date}</td>
                <td>{hm(s.wearMinutes)}</td>
                <td>{cell("activity", n(s.steps, "보"))}</td>
                <td>{cell("activity", n(s.activeMinutes, "분"))}</td>
                <td>{cell("sleep", hm(s.sleepMinutes))}</td>
                <td>{cell("heart_rate", n(s.restingHeartRate, "bpm"))}</td>
                <td>{cell("spo2", n(s.spo2Min, "%"))}</td>
                {ringCols && <>
                  <td>{cell("vitality", n(s.vitalityScore))}</td>
                  <td>{cell("hrv", n(s.hrvRmssd, "ms"))}</td>
                  <td>{cell("skin_temp", typeof s.skinTempDeviationC === "number" ? `${s.skinTempDeviationC > 0 ? "+" : ""}${s.skinTempDeviationC.toFixed(1)}℃` : "—")}</td>
                </>}
                <td>{granted.has("fall") || granted.has("sos") ? `${s.fallEvents ?? "—"} / ${s.sosEvents ?? "—"}` : <span className="muted">미동의</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </div>
  );
}
