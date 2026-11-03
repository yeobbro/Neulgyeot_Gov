import { PageHead, Panel, CapacityBadge, Badge, DemoTag, Empty } from "@/components/ui";
import { ApiForm } from "@/components/client/ApiForm";
import { SERVICE_TYPES, SERVICE_TYPE_LABEL, CAPACITY_STATUSES, CAPACITY_LABEL, type ServiceType } from "@/lib/domain/enums";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { listProviders } from "@/lib/server/services/providers";
import { listRegions } from "@/lib/server/services/admin";
import { PublicProviderImport, ProviderVerificationButton } from "@/components/client/PublicProviderImport";

export const metadata = { title: "서비스 카탈로그·제공기관" };
export default async function ProvidersPage({ searchParams }: { searchParams: Promise<{ serviceType?: string; region?: string }> }) {
  const sp = await searchParams;
  const d = await withPage(async (tx, a) => ({
    providers: await listProviders(tx, a, sp),
    catalog: await tx.query<{ service_type: ServiceType; name: string; department: string; is_active: boolean }>(`SELECT service_type, name, department, is_active FROM service_catalog ORDER BY service_type`),
    regions: (await listRegions(tx)).filter((r) => r.level === "eupmyeondong"),
    isAdmin: a.roles.includes("municipal_admin"),
  }), { roles: ["municipal_admin", "case_manager"] });
  return (
    <>
      <PageHead title="서비스 카탈로그 및 제공기관" desc="수용 가능 여부는 마지막 확인 시각과 함께 표시하며, 확인 기간이 지난 정보는 '확인 필요'로 표시합니다." />
      <div className="stack">
        <Panel title="서비스 카탈로그" id="catalog" note="서비스 종류와 담당 부서는 지자체별로 설정할 수 있습니다.">
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
            <thead><tr><th scope="col">서비스 유형</th><th scope="col">명칭</th><th scope="col">담당 부서</th><th scope="col">운영</th></tr></thead>
            <tbody>{d.catalog.map((c) => <tr key={c.service_type}><td>{SERVICE_TYPE_LABEL[c.service_type]}</td><td>{c.name}</td><td>{c.department}</td><td>{c.is_active ? "운영" : "중지"}</td></tr>)}</tbody>
          </table></div>
        </Panel>
        <section className="panel" aria-labelledby="prov-h">
          <div className="panel-head"><h2 id="prov-h">서비스 제공기관</h2></div>
          <form className="filters" role="search">
            <div className="field"><label htmlFor="p-type">서비스 유형</label><select id="p-type" name="serviceType" defaultValue={sp.serviceType ?? ""}><option value="">전체</option>{SERVICE_TYPES.map((t) => <option key={t} value={t}>{SERVICE_TYPE_LABEL[t]}</option>)}</select></div>
            <div className="field"><label htmlFor="p-reg">담당 지역</label><select id="p-reg" name="region" defaultValue={sp.region ?? ""}><option value="">전체</option>{d.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
            <button className="btn" type="submit">조회</button>
          </form>
          {d.providers.length === 0 ? <Empty>조건에 맞는 기관 없음</Empty> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
              <thead><tr><th scope="col">기관명</th><th scope="col">기관 유형</th><th scope="col" className="wrap">서비스 유형 · 수용 상태 (마지막 확인)</th><th scope="col" className="wrap">담당 지역</th><th scope="col">주소·좌표</th><th scope="col">연락처</th><th scope="col">운영 시간</th><th scope="col" className="wrap">제공 조건</th><th scope="col">데이터 출처·검증</th>{d.isAdmin && <th scope="col">검증 처리</th>}</tr></thead>
              <tbody>{d.providers.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.name} {p.is_synthetic && <DemoTag />}{!p.is_active && <Badge tone="gray">운영 중지</Badge>}</td>
                  <td>{p.provider_type}</td>
                  <td className="wrap">{p.capacity.map((c: any) => <div key={c.serviceType} style={{ marginBottom: 2 }}>{SERVICE_TYPE_LABEL[c.serviceType as ServiceType]} <CapacityBadge s={c.status} label={c.stale ? "확인 필요" : c.label} /> <small className="panel-note">{c.confirmedAt ? fmtDate(c.confirmedAt) : "확인 이력 없음"}{c.waitlist !== null ? ` · 대기 ${c.waitlist}` : ""}</small></div>)}</td>
                  <td className="wrap">{p.regions.join(", ")}</td>
                  <td>{p.address_label}{p.coords_synthetic && <small className="panel-note"> (합성 좌표)</small>}</td>
                  <td>{p.contact_label}</td><td>{p.operating_hours}</td><td className="wrap">{p.conditions}</td><td>{p.data_source}<div className="panel-note">{p.verification_status === "verified" ? "관리자 검증 완료" : p.verification_status === "imported_unverified" ? "공공데이터 가져옴 · 미검증" : p.verification_status === "rejected" ? "검증 반려" : "DEMO 데이터"}</div>{p.source_url && <a className="panel-note" href={p.source_url} target="_blank" rel="noopener noreferrer">원본</a>}</td>{d.isAdmin && <td>{p.verification_status === "imported_unverified" ? <ProviderVerificationButton providerId={p.id} verified={false} /> : p.verification_status === "verified" ? <ProviderVerificationButton providerId={p.id} verified={true} /> : "—"}</td>}
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        {d.isAdmin && (
          <Panel title="수용 가능 여부 확인 기록 (지자체 확인)" id="cap" note={`기관 직접 입력이 원칙이며, 전화 확인 등은 확인 시각(${fmtDateTime(new Date())})과 함께 기록됩니다.`}>
            {d.providers.slice(0, 50).map((p: any) => (
              <details key={p.id} className="disclosure" style={{ marginBottom: 6 }}><summary>{p.name}</summary><div>
                <ApiForm action={`/api/providers/${p.id}/capacity`} inline submitLabel="확인 기록" fields={[
                  { name: "serviceType", label: "서비스", type: "select", required: true, options: p.serviceTypes.map((t: ServiceType) => ({ value: t, label: SERVICE_TYPE_LABEL[t] })) },
                  { name: "status", label: "수용 상태", type: "select", required: true, options: CAPACITY_STATUSES.map((s) => ({ value: s, label: CAPACITY_LABEL[s] })) },
                  { name: "waitlistCount", label: "대기 인원", type: "number" },
                ]} />
              </div></details>
            ))}
          </Panel>
        )}
      </div>
    </>
  );
}
