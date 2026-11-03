import { PageHead, Panel, CapacityBadge } from "@/components/ui";
import { ApiForm } from "@/components/client/ApiForm";
import { CAPACITY_LABEL, CAPACITY_STATUSES, SERVICE_TYPE_LABEL, type CapacityStatus, type ServiceType } from "@/lib/domain/enums";
import { capacityFreshness } from "@/lib/domain/matching";
import { fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { forbidden } from "@/lib/server/errors";

export const metadata = { title: "수용 현황 등록" };
export default async function ProviderCapacity() {
  const d = await withPage(async (tx, a) => {
    if (!a.providerId) throw forbidden();
    const types = await tx.query<{ service_type: ServiceType }>(`SELECT DISTINCT service_type FROM provider_service_areas WHERE provider_id = $1`, [a.providerId]);
    const caps = await tx.query<{ service_type: ServiceType; status: CapacityStatus; confirmed_at: string; waitlist_count: number | null }>(`SELECT DISTINCT ON (service_type) service_type, status, confirmed_at, waitlist_count FROM provider_capacity_snapshots WHERE provider_id = $1 ORDER BY service_type, confirmed_at DESC`, [a.providerId]);
    return { providerId: a.providerId, org: a.organizationName, types: types.map((t) => t.service_type), caps };
  }, { roles: ["service_provider"] });
  return (
    <>
      <PageHead title="수용 가능 여부 등록" desc={`${d.org} — 최신 등록 시각이 지자체 매칭 화면에 함께 표시됩니다. 오래된 정보는 '확인 필요'로 표시됩니다.`} />
      <Panel title="현재 등록 상태">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data"><thead><tr><th scope="col">서비스</th><th scope="col">상태</th><th scope="col">대기</th><th scope="col">마지막 확인</th></tr></thead>
          <tbody>{d.types.map((t) => { const c = d.caps.find((x) => x.service_type === t); const v = capacityFreshness(c ? { status: c.status, confirmedAt: new Date(c.confirmed_at).toISOString() } : null, new Date()); return <tr key={t}><td>{SERVICE_TYPE_LABEL[t]}</td><td><CapacityBadge s={v.status} label={v.stale ? "확인 필요" : v.label} /></td><td>{c?.waitlist_count ?? "—"}</td><td>{fmtDateTime(c?.confirmed_at)}</td></tr>; })}</tbody></table></div>
        <div style={{ marginTop: 12 }}>
          <ApiForm action={`/api/providers/${d.providerId}/capacity`} submitLabel="수용 현황 등록" fields={[
            { name: "serviceType", label: "서비스", type: "select", required: true, options: d.types.map((t) => ({ value: t, label: SERVICE_TYPE_LABEL[t] })) },
            { name: "status", label: "수용 상태", type: "select", required: true, options: CAPACITY_STATUSES.map((s) => ({ value: s, label: CAPACITY_LABEL[s] })) },
            { name: "waitlistCount", label: "대기 인원", type: "number" },
          ]} />
        </div>
      </Panel>
    </>
  );
}
