import Link from "next/link";
import { PageHead, Panel, Bars } from "@/components/ui";
import { PrintButton } from "@/components/client/PrintButton";
import { fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { buildReport } from "@/lib/server/services/insights";

export const metadata = { title: "보고서·통계" };
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const y = new Date().getFullYear();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : `${y}-01-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : `${y}-12-31`;
  const r = await withPage((tx, a) => buildReport(tx, a, { from, to }), { roles: ["municipal_admin", "case_manager"] });
  const rows = r.sections.reduce((a, s) => a + s.rows.length, 0);
  return (
    <>
      <PageHead title="보고서 및 통계" desc={<>기간 {r.period.from} ~ {r.period.to} · 범위 {r.scope} · 기준일(생성 시각) {fmtDateTime(r.generatedAt)}</>}
        actions={<><Link className="btn" prefetch={false} href={`/api/reports/export?from=${from}&to=${to}`}>CSV 내보내기</Link><PrintButton type="report" rows={rows} /></>} />
      <div className="alert alert-warn" style={{ marginBottom: 12 }}>{r.notice} 개인 식별 정보는 통계 화면에 표시하지 않습니다.</div>
      <form className="filters panel no-print" style={{ marginBottom: 12, borderRadius: 6 }}>
        <div className="field"><label htmlFor="r-from">시작일</label><input id="r-from" name="from" type="date" defaultValue={from} /></div>
        <div className="field"><label htmlFor="r-to">종료일</label><input id="r-to" name="to" type="date" defaultValue={to} /></div>
        <button className="btn" type="submit">조회</button>
      </form>
      <Panel title="데이터 품질 (누락률)" id="dq">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
          <thead><tr><th scope="col">지표</th><th scope="col" className="num">누락</th><th scope="col" className="num">전체</th><th scope="col" className="num">누락률</th></tr></thead>
          <tbody>{r.dataQuality.map((q) => <tr key={q.label}><td>{q.label}</td><td className="num">{q.missing}</td><td className="num">{q.total}</td><td className="num">{q.total ? `${((q.missing / q.total) * 100).toFixed(1)}%` : "데이터 없음"}</td></tr>)}</tbody>
        </table></div>
      </Panel>
      <div className="grid-2" style={{ marginTop: 16 }}>
        {r.sections.map((s) => (
          <Panel key={s.key} title={s.title} id={`s-${s.key}`} note={<><strong>정의</strong> {s.definition}<br /><strong>산식</strong> <code>{s.formula}</code></>}>
            <Bars rows={s.rows} label={s.title} />
          </Panel>
        ))}
      </div>
    </>
  );
}
