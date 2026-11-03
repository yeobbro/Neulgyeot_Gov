import { PageHead, Panel, Badge, Empty } from "@/components/ui";
import { SERVICE_TYPES, SERVICE_TYPE_LABEL, CAPACITY_LABEL, type ServiceType, type CapacityStatus } from "@/lib/domain/enums";
import { withPage } from "@/lib/server/page";
import { mapData } from "@/lib/server/services/insights";
import { listProviders } from "@/lib/server/services/providers";

export const metadata = { title: "지역 자원 지도" };
const CAP_COLOR: Record<CapacityStatus, string> = { available: "#1d7a3d", limited: "#9a5b00", full: "#b42318", unknown: "#6b7486" };

export default async function MapPage({ searchParams }: { searchParams: Promise<{ type?: string; sel?: string }> }) {
  const sp = await searchParams;
  const { m, providers } = await withPage(async (tx, a) => ({ m: await mapData(tx, a), providers: await listProviders(tx, a, { serviceType: sp.type }) }), { roles: ["municipal_admin", "case_manager"] });
  const selected = sp.sel;
  const q = (extra: Record<string, string | undefined>) => `/map?${new URLSearchParams(Object.entries({ type: sp.type, sel: sp.sel, ...extra }).filter(([, v]) => v) as [string, string][])}`;
  const capOf = (p: any) => (p.capacity.find((c: any) => !sp.type || c.serviceType === sp.type)?.status ?? "unknown") as CapacityStatus;
  return (
    <>
      <PageHead title="지역 자원 지도" desc={m.notice} />
      <div className="alert alert-warn" style={{ marginBottom: 12 }}>합성 지도입니다. 실제 행정구역 경계·지도 데이터(출처·라이선스 확인 필요)가 준비되지 않아 격자 위 가상 배치로 표시합니다.</div>
      <form className="filters panel" role="search" style={{ marginBottom: 12, borderRadius: 6 }}>
        <div className="field"><label htmlFor="m-type">서비스 유형</label><select id="m-type" name="type" defaultValue={sp.type ?? ""}><option value="">전체</option>{SERVICE_TYPES.map((t) => <option key={t} value={t}>{SERVICE_TYPE_LABEL[t]}</option>)}</select></div>
        <button className="btn" type="submit">적용</button>
      </form>
      <div className="split">
        <Panel title="권역·기관 배치 (합성)" id="map">
          <div className="map-wrap">
            <svg viewBox="0 0 100 80" role="group" aria-labelledby="map-title map-desc">
              <title id="map-title">가온시 합성 지역 자원 지도</title>
              <desc id="map-desc">읍·면·동 권역 원과 서비스 제공기관 위치(합성 좌표)를 표시합니다. 같은 정보가 오른쪽 목록에 있습니다.</desc>
              {m.regions.map((r) => (
                <g key={r.id}>
                  <circle cx={r.map_x} cy={r.map_y * 0.8} r={17} fill={r.gaps.length ? "#fdf3e1" : "#e8f0fc"} stroke={r.gaps.length ? "#e0b25c" : "#9fb7e0"} strokeWidth={0.4} />
                  <text x={r.map_x} y={r.map_y * 0.8 - 12} fontSize={3.2} textAnchor="middle" fill="#1a2233" fontWeight={700}>{r.name}</text>
                  <text x={r.map_x} y={r.map_y * 0.8 + 14} fontSize={2.4} textAnchor="middle" fill="#4a5568">{r.openCases === null ? "권한 밖" : `사례 ${r.openCases}`} · 공백 {r.gaps.length}</text>
                </g>
              ))}
              {providers.filter((p: any) => p.map_x !== null).map((p: any) => (
                <a key={p.id} href={q({ sel: p.id })} aria-label={`${p.name} 선택`}>
                  <circle cx={p.map_x} cy={p.map_y * 0.8} r={selected === p.id ? 2.4 : 1.6} fill={CAP_COLOR[capOf(p)]} stroke="#fff" strokeWidth={0.5} />
                </a>
              ))}
            </svg>
          </div>
          <div className="row" style={{ marginTop: 8, fontSize: 12 }}>
            {(Object.keys(CAP_COLOR) as CapacityStatus[]).map((k) => <span key={k} className="row"><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill={CAP_COLOR[k]} /></svg>{CAPACITY_LABEL[k]}</span>)}
            <span className="row"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="#fdf3e1" stroke="#e0b25c" /></svg>서비스 공백 있음</span>
          </div>
        </Panel>
        <div className="stack">
          <Panel title="권역별 자원·공백" id="gaps" note="개별 대상자 위치는 표시하지 않습니다. 사례 수는 권한 범위 내 권역만 표시합니다.">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
              <thead><tr><th scope="col">권역</th><th scope="col" className="num">관리 사례</th><th scope="col" className="num">제공 유형 수</th><th scope="col" className="wrap">서비스 공백</th></tr></thead>
              <tbody>{m.regions.map((r) => <tr key={r.id}><td>{r.name}</td><td className="num">{r.openCases ?? "—"}</td><td className="num">{r.serviceTypesCovered}</td><td className="wrap">{r.gaps.length ? r.gaps.map((g) => <Badge key={g.serviceType} tone="amber">{g.label} ({g.demand})</Badge>) : "없음"}</td></tr>)}</tbody>
            </table></div>
          </Panel>
          <Panel title={`기관 목록 (${providers.length})`} id="plist">
            {providers.length === 0 ? <Empty /> : (
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {providers.map((p: any) => (
                  <li key={p.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", background: selected === p.id ? "var(--blue-soft)" : undefined }}>
                    <a href={q({ sel: p.id })} style={{ textDecoration: "underline" }} aria-current={selected === p.id ? "true" : undefined}>{p.name}</a>
                    <div className="panel-note">{p.serviceTypes.map((t: ServiceType) => SERVICE_TYPE_LABEL[t]).join(", ")} · {CAPACITY_LABEL[capOf(p)]}</div>
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
