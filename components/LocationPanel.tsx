import { Badge, Panel } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/client/ApiForm";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { getLocationSettings } from "@/lib/server/services/control";

type Settings = Awaited<ReturnType<typeof getLocationSettings>>;

/** 사례 상세 → 웨어러블 탭 → 위치. 지정 위치(거주지 근사)와 실시간 위치 수집 동의를 분리해 관리합니다. */
export function LocationPanel({ caseId, data, canWrite, hasDevice }: { caseId: string; data: Settings; canWrite: boolean; hasDevice: boolean }) {
  const active = data.consent?.status === "active";
  return (
    <Panel title="위치" id="loc" note="통합 관제 지도는 위치정보 수집 동의가 있고 30분 이내 위치가 수신된 경우에만 실시간 위치를 표시하며, 그 밖에는 지정 위치만 표시합니다.">
      <div className="grid-2">
        <div>
          <h3>지정 위치 (거주지 등)</h3>
          {data.designated ? (
            <p>{data.designated.label} <small className="muted">· {Number(data.designated.latitude).toFixed(4)}, {Number(data.designated.longitude).toFixed(4)} · {fmtDateTime(data.designated.updated_at)}</small></p>
          ) : <p className="muted">등록된 지정 위치 없음 — 지도에 표시되지 않습니다.</p>}
          {canWrite && (
            <ApiForm action={`/api/cases/${caseId}/location`} submitLabel="지정 위치 저장" successMessage="저장했습니다." testId="designated-location" fields={[
              { name: "label", label: "표시 이름", type: "text", required: true, maxLength: 120, defaultValue: data.designated?.label ?? "거주지 근사 위치", help: "상세 주소 대신 근사 위치 설명을 권장합니다." },
              { name: "latitude", label: "위도", type: "number", required: true, defaultValue: data.designated ? String(data.designated.latitude) : "" },
              { name: "longitude", label: "경도", type: "number", required: true, defaultValue: data.designated ? String(data.designated.longitude) : "" },
            ]} />
          )}
        </div>
        <div>
          <h3>실시간 위치 수집 동의 {active ? <Badge tone="green">유효</Badge> : data.consent ? <Badge tone="gray">철회됨</Badge> : <Badge tone="gray">없음</Badge>}</h3>
          {data.consent && (
            <dl className="kv">
              <dt>법적 근거</dt><dd>{data.consent.legal_basis}</dd>
              <dt>동의 일자 · 보관</dt><dd>{fmtDate(data.consent.consent_recorded_at)} · {data.consent.retention_hours}시간</dd>
              <dt>마지막 위치 수신</dt><dd>{data.lastFixAt ? fmtDateTime(data.lastFixAt) : "없음"}</dd>
            </dl>
          )}
          {canWrite && active && <ActionButton action={`/api/cases/${caseId}/location/consent/withdraw`} label="위치 동의 철회 · 수집 중지" tone="danger" testId="location-withdraw" />}
          {canWrite && !active && (hasDevice ? (
            <ApiForm action={`/api/cases/${caseId}/location/consent`} submitLabel="위치 동의 등록" successMessage="등록했습니다." testId="location-consent" fields={[
              { name: "legalBasis", label: "법적 근거", type: "text", required: true, maxLength: 200, defaultValue: "개인위치정보 수집·이용 별도 동의(위치정보법 제18조)" },
              { name: "consentRecordedAt", label: "동의 일자", type: "date", required: true },
              { name: "retentionHours", label: "위치 보관 시간", type: "number", required: true, defaultValue: "72", help: "1~720시간. 지난 위치는 파기 배치가 삭제합니다." },
              { name: "separateConsentConfirmed", label: "위치정보 수집·이용 별도 동의서(필요 시 보호자 동의 포함)를 확인했습니다.", type: "checkbox", full: true },
            ]} />
          ) : <p className="muted">위치를 보낼 웨어러블 기기를 먼저 등록하세요.</p>)}
        </div>
      </div>
    </Panel>
  );
}
