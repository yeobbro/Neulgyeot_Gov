import Link from "next/link";
import { PageHead, Panel, Badge, Empty } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { auditQuery, listAudit } from "@/lib/server/services/insights";

export const metadata = { title: "감사 로그" };
const GROUPS = ["auth", "case", "record", "referral", "assessment", "plan", "meeting", "service_referral", "monitoring", "export", "ai", "user", "access", "recipient", "settings"];
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = auditQuery.parse(await searchParams);
  const d = await withPage((tx, a) => listAudit(tx, a, q), { roles: ["auditor", "municipal_admin"] });
  return (
    <>
      <PageHead title="감사 로그" desc="감사 로그에는 개인정보·건강정보 본문을 저장하지 않으며, 대상 ID와 처리 메타데이터만 기록합니다. 기록은 추가만 가능하고 수정·삭제할 수 없습니다." />
      <section className="panel">
        <form className="filters" role="search">
          <div className="field"><label htmlFor="a-act">이벤트 분류</label><select id="a-act" name="action" defaultValue={q.action ?? ""}><option value="">전체</option>{GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}</select></div>
          <div className="field"><label htmlFor="a-out">결과</label><select id="a-out" name="outcome" defaultValue={q.outcome ?? ""}><option value="">전체</option><option value="success">성공</option><option value="denied">거부</option><option value="failure">실패</option></select></div>
          <button className="btn" type="submit">조회</button>
        </form>
        {d.rows.length === 0 ? <Empty /> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
            <thead><tr><th scope="col">시각</th><th scope="col">이벤트</th><th scope="col">결과</th><th scope="col">수행자</th><th scope="col">역할</th><th scope="col">대상</th><th scope="col" className="wrap">메타데이터</th></tr></thead>
            <tbody>{d.rows.map((r: any, i: number) => <tr key={i}><td>{fmtDateTime(r.at)}</td><td><code>{r.action}</code></td><td><Badge tone={r.outcome === "success" ? "green" : r.outcome === "denied" ? "red" : "amber"}>{r.outcome}</Badge></td><td>{r.actor_name ?? "시스템"}</td><td>{r.actor_role ?? "—"}</td><td>{r.entity_type ? `${r.entity_type}:${String(r.entity_id ?? "").slice(0, 24)}` : "—"}</td><td className="wrap"><code style={{ fontSize: 11 }}>{JSON.stringify(r.meta)}</code></td></tr>)}</tbody>
          </table></div>
        )}
        <nav className="pager" aria-label="페이지">{q.page > 1 && <Link className="btn btn-sm" href={`/audit?page=${q.page - 1}`}>이전</Link>}{d.rows.length === 50 && <Link className="btn btn-sm" href={`/audit?page=${q.page + 1}`}>다음</Link>}</nav>
      </section>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <Panel title="데이터 내보내기 이력" id="exp">
          {d.exports.length === 0 ? <Empty /> : <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data"><thead><tr><th scope="col">시각</th><th scope="col">유형</th><th scope="col">형식</th><th scope="col" className="num">행 수</th><th scope="col">개인정보 포함</th><th scope="col">수행자</th></tr></thead>
            <tbody>{d.exports.map((e: any, i: number) => <tr key={i}><td>{fmtDateTime(e.at)}</td><td>{e.export_type}</td><td>{e.format}</td><td className="num">{e.row_count}</td><td>{e.contains_personal_data ? "예" : "아니오"}</td><td>{e.actor_name}</td></tr>)}</tbody></table></div>}
        </Panel>
        <Panel title="상태 변경 이력 (연계·서비스)" id="sh">
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data"><thead><tr><th scope="col">시각</th><th scope="col">구분</th><th scope="col">번호</th><th scope="col">변경</th><th scope="col">처리 주체</th></tr></thead>
            <tbody>{d.statusHistory.map((s: any, i: number) => <tr key={i}><td>{fmtDateTime(s.at)}</td><td>{s.kind === "referral" ? "병원 연계" : "서비스 의뢰"}</td><td>{s.ref}</td><td>{s.from_status ?? "—"} → {s.to_status}</td><td>{s.actor}</td></tr>)}</tbody></table></div>
        </Panel>
      </div>
    </>
  );
}
