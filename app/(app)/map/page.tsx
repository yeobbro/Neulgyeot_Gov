import { PageHead, Panel, Badge, Empty } from "@/components/ui";
import { SERVICE_TYPES, SERVICE_TYPE_LABEL, CAPACITY_LABEL, type ServiceType, type CapacityStatus } from "@/lib/domain/enums";
import { withPage } from "@/lib/server/page";
import { mapData } from "@/lib/server/services/insights";
import { listProviders } from "@/lib/server/services/providers";

export const metadata = { title: "지역 자원 지도" };
const CAP_COLOR: Record<CapacityStatus, string> = { available: "#1d7a3d", limited: "#9a5b00", full: "#b42318", unknown: "#6b7486" };

type MapPoint = { latitude: number | null; longitude: number | null; name: string };

export default async function MapPage({ searchParams }: { searchParams: Promise<{ type?: string; sel?: string; region?: string }> }) {
  const sp = await searchParams;
  const { m, providers } = await withPage(async (tx, a) => ({
    m: await mapData(tx, a),
    providers: await listProviders(tx, a, { serviceType: sp.type, region: sp.region }),
  }), { roles: ["municipal_admin", "case_manager"] });

  const selectedProvider = sp.sel;
  const selectedRegion = m.regions.find((r) => r.id === sp.region);
  const district = m.municipality as MapPoint | null;
  const center = (selectedRegion ?? district) as MapPoint | null;
  const hasCoordinates = center?.latitude != null && center?.longitude != null;
  const latitude = hasCoordinates ? center.latitude! : 37.4951;
  const longitude = hasCoordinates ? center.longitude! : 127.06278;

  // A reference point only. Do not interpret this as an administrative boundary,
  // resident address, home visit address or service-provider location.
  const lonRadius = selectedRegion ? 0.012 : 0.065;
  const latRadius = selectedRegion ? 0.008 : 0.045;
  const bbox = [
    longitude - lonRadius,
    latitude - latRadius,
    longitude + lonRadius,
    latitude + latRadius,
  ].map((v) => v.toFixed(5)).join(",");
  const marker = hasCoordinates ? `&marker=${latitude.toFixed(5)},${longitude.toFixed(5)}` : "";
  const mapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${marker}`;
  const mapLink = `https://www.openstreetmap.org/#map=${selectedRegion ? 15 : 13}/${latitude.toFixed(5)}/${longitude.toFixed(5)}`;

  const q = (extra: Record<string, string | undefined>) => {
    const values = { type: sp.type, region: sp.region, sel: sp.sel, ...extra };
    const params = new URLSearchParams(Object.entries(values).filter(([, v]) => v) as [string, string][]);
    return `/map?${params.toString()}`;
  };
  const capOf = (p: any) => (p.capacity.find((c: any) => !sp.type || c.serviceType === sp.type)?.status ?? "unknown") as CapacityStatus;

  return (
    <>
      <PageHead
        title="지역 자원 지도"
        desc="서울특별시 강남구의 실제 행정동 명칭과 도로 지도를 바탕으로 권역별 자원 현황을 살펴봅니다."
      />
      <div className="alert alert-info" style={{ marginBottom: 12 }}>
        <strong>실제 지리 정보 + 합성 업무 데이터</strong> · 지도와 행정동 명칭은 실제 지역을 사용합니다.
        사례·기관·수용 현황은 모두 시연용 합성 데이터이며, 지도 마커는 권역 참고 중심점입니다.
        공식 행정경계, 대상자 주소, 실제 기관 위치를 표시하지 않습니다.
      </div>

      <form className="filters panel" role="search" style={{ marginBottom: 12, borderRadius: 6 }}>
        <div className="field">
          <label htmlFor="m-region">행정동</label>
          <select id="m-region" name="region" defaultValue={sp.region ?? ""}>
            <option value="">강남구 전체</option>
            {m.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="m-type">서비스 유형</label>
          <select id="m-type" name="type" defaultValue={sp.type ?? ""}>
            <option value="">전체</option>
            {SERVICE_TYPES.map((t) => <option key={t} value={t}>{SERVICE_TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        <button className="btn" type="submit">적용</button>
        <a className="btn" href="/map">필터 초기화</a>
      </form>

      <div className="split">
        <Panel title={`실제 지도 · ${selectedRegion?.name ?? district?.name ?? "강남구"}`} id="map" note="권역 대표 위치를 보여주는 참고 지도입니다. 동 경계 폴리곤은 아직 연결하지 않았습니다.">
          <div className="map-wrap map-wrap-real">
            <iframe
              title={`OpenStreetMap — ${selectedRegion?.name ?? district?.name ?? "서울특별시 강남구"}`}
              src={mapSrc}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
          <div className="map-attribution">
            <span>지도 데이터: © OpenStreetMap contributors</span>
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">라이선스</a>
            <a href={mapLink} target="_blank" rel="noopener noreferrer">큰 지도에서 열기</a>
          </div>
          <div className="alert alert-warn" style={{ marginTop: 10 }}>
            표시된 핀은 {selectedRegion ? selectedRegion.name : "강남구"}의 대략적인 권역 기준점입니다.
            가구·환자·제공기관의 실제 위치가 아닙니다.
          </div>
          <div className="row" style={{ marginTop: 10, fontSize: 12 }}>
            <span className="row"><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="#1f5fbf" /></svg>권역 참고 중심점</span>
            {(Object.keys(CAP_COLOR) as CapacityStatus[]).map((k) => (
              <span key={k} className="row"><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill={CAP_COLOR[k]} /></svg>{CAPACITY_LABEL[k]}</span>
            ))}
            <span>※ 수용 상태는 합성 시연 데이터이며 지도에 기관 핀으로 표시하지 않습니다.</span>
          </div>
        </Panel>

        <div className="stack">
          <Panel title="행정동별 자원·서비스 공백" id="gaps" note="사례 수는 로그인한 계정의 권한 범위 내에서만 집계됩니다.">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="행정동별 자원 현황">
              <table className="data">
                <thead><tr><th scope="col">행정동</th><th scope="col" className="num">관리 사례</th><th scope="col" className="num">제공 유형 수</th><th scope="col" className="wrap">서비스 공백</th></tr></thead>
                <tbody>
                  {m.regions.map((r) => (
                    <tr key={r.id}>
                      <td><a href={q({ region: r.id, sel: undefined })} aria-current={sp.region === r.id ? "true" : undefined}>{r.name}</a></td>
                      <td className="num">{r.openCases ?? "—"}</td>
                      <td className="num">{r.serviceTypesCovered}</td>
                      <td className="wrap">{r.gaps.length ? r.gaps.map((g) => <Badge key={g.serviceType} tone="amber">{g.label} ({g.demand})</Badge>) : "없음"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title={`시연 제공기관 (${providers.length})`} id="plist" note="기관명·주소·연락처·수용 현황은 모두 합성 데이터입니다. 실제 기관으로 오인하지 않도록 지도 핀은 제공하지 않습니다.">
            {providers.length === 0 ? <Empty>조건에 맞는 시연기관이 없습니다.</Empty> : (
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {providers.map((p: any) => (
                  <li key={p.id} style={{ padding: "7px 0", borderBottom: "1px solid var(--line)", background: selectedProvider === p.id ? "var(--blue-soft)" : undefined }}>
                    <a href={q({ sel: selectedProvider === p.id ? undefined : p.id })} style={{ textDecoration: "underline" }} aria-current={selectedProvider === p.id ? "true" : undefined}>{p.name}</a>
                    <div className="panel-note">{p.serviceTypes.map((t: ServiceType) => SERVICE_TYPE_LABEL[t]).join(", ")} · {CAPACITY_LABEL[capOf(p)]}</div>
                    <div className="panel-note">{p.regions.join(", ")} · {p.address_label}</div>
                    <span className="badge b-demo">시연용 합성기관</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
