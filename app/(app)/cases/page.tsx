import Link from "next/link";
import { PageHead, Pager, CaseBadge, Empty } from "@/components/ui";
import { CASE_STATUSES, CASE_STATUS_LABEL, INTAKE_ROUTES, INTAKE_ROUTE_LABEL, type IntakeRoute } from "@/lib/domain/enums";
import { STATUS_GROUPS } from "@/lib/domain/metrics";
import { fmtDate, isPast } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { caseListQuery, listCases } from "@/lib/server/services/cases";
import { listRegions } from "@/lib/server/services/admin";

export const metadata = { title: "사례관리" };
const FILTER_LABEL: Record<string, string> = { overdue: "조치일 경과", unlinked: "서비스 미연계", mine: "내 배정 사례", monitoring_due: "모니터링 예정", open: "진행 중 전체" };

export default async function CasesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const q = caseListQuery.parse(sp);
  const { data, regions } = await withPage(async (tx, actor) => ({
    data: await listCases(tx, actor, q),
    regions: (await listRegions(tx)).filter((r) => r.level === "eupmyeondong" && (actor.regionScope === null || actor.regionScope.includes(r.id))),
  }), { roles: ["municipal_admin", "case_manager"] });
  const params = new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== "page" && v) as [string, string][]);
  const active = q.group ? STATUS_GROUPS[q.group]?.label : q.filter ? FILTER_LABEL[q.filter] : null;
  return (
    <>
      <PageHead title="대상자 및 사례관리" desc={active ? `필터: ${active}` : "담당 권한 범위 내 사례만 표시됩니다."}
        actions={<><Link className="btn" href="/api/exports/cases" prefetch={false}>CSV 내보내기</Link><Link className="btn btn-primary" href="/cases/new">신규 신청 등록</Link></>} />
      <section className="panel">
        <form className="filters" role="search" aria-label="사례 검색 필터">
          <div className="field"><label htmlFor="f-q">사례코드·표시명 검색</label><input id="f-q" name="q" type="search" defaultValue={q.q ?? ""} /></div>
          <div className="field"><label htmlFor="f-status">사례 상태</label>
            <select id="f-status" name="status" defaultValue={q.status ?? ""}><option value="">전체</option>{CASE_STATUSES.map((s) => <option key={s} value={s}>{CASE_STATUS_LABEL[s]}</option>)}</select></div>
          <div className="field"><label htmlFor="f-route">신청 경로</label>
            <select id="f-route" name="route" defaultValue={q.route ?? ""}><option value="">전체</option>{INTAKE_ROUTES.map((s) => <option key={s} value={s}>{INTAKE_ROUTE_LABEL[s]}</option>)}</select></div>
          <div className="field"><label htmlFor="f-region">권역</label>
            <select id="f-region" name="region" defaultValue={q.region ?? ""}><option value="">전체</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
          <div className="field"><label htmlFor="f-filter">업무 필터</label>
            <select id="f-filter" name="filter" defaultValue={q.filter ?? ""}><option value="">없음</option>{Object.entries(FILTER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label htmlFor="f-sort">정렬</label>
            <select id="f-sort" name="sort" defaultValue={q.sort}><option value="next_action">다음 조치일순</option><option value="updated">최근 변경순</option><option value="code">사례코드순</option></select></div>
          {q.group && <input type="hidden" name="group" value={q.group} />}
          <button className="btn" type="submit">조회</button>
          <Link className="btn" href="/cases">초기화</Link>
        </form>
        {data.data.length === 0 ? <Empty>조건에 맞는 사례가 없습니다 (0건).</Empty> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
            <table className="data">
              <thead><tr>
                <th scope="col">사례 코드</th><th scope="col">대상자(가명)</th><th scope="col">담당 권역</th><th scope="col">사례 상태</th><th scope="col">신청 경로</th>
                <th scope="col">담당자</th><th scope="col">최근 상담일</th><th scope="col" className="wrap">다음 후속 조치</th><th scope="col" className="num">미완료 업무</th>
              </tr></thead>
              <tbody>
                {data.data.map((c: any) => (
                  <tr key={c.id}>
                    <td><Link href={`/cases/${c.id}`}>{c.case_code}</Link></td>
                    <td>{c.display_name}{c.age_band ? ` · ${c.age_band}` : ""}</td>
                    <td>{c.region_name}</td><td><CaseBadge s={c.status} /></td>
                    <td>{INTAKE_ROUTE_LABEL[c.intake_route as IntakeRoute]}</td><td>{c.worker_name ?? "미배정"}</td>
                    <td>{fmtDate(c.last_contact_at)}</td>
                    <td className="wrap">{c.next_action_at ? <><span className={isPast(c.next_action_at) ? "badge b-red" : ""}>{fmtDate(c.next_action_at)}</span> {c.next_action_label}</> : "—"}</td>
                    <td className="num">{c.open_tasks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} base={`/cases?${params}`} />
      </section>
    </>
  );
}
