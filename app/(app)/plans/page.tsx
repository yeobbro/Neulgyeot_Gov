import Link from "next/link";
import { PageHead, Panel, PlanBadge, Badge, Empty } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { listPlansOverview } from "@/lib/server/services/plans";

export const metadata = { title: "지원계획·통합지원회의" };
export default async function PlansPage() {
  const d = await withPage((tx, a) => listPlansOverview(tx, a), { roles: ["municipal_admin", "case_manager"] });
  return (
    <>
      <PageHead title="개인별 지원계획 · 통합지원회의" desc="계획 작성·수정·승인과 회의 결과 기록은 각 사례 상세의 '지원계획·회의' 탭에서 진행합니다." />
      <div className="stack">
        <Panel title="통합지원회의 일정" id="mtg">
          {d.meetings.length === 0 ? <Empty>등록된 회의 없음</Empty> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
              <thead><tr><th scope="col">일시</th><th scope="col">사례</th><th scope="col" className="wrap">안건</th><th scope="col">상태</th></tr></thead>
              <tbody>{d.meetings.map((m: any) => <tr key={m.id}><td>{fmtDateTime(m.scheduled_at)}</td><td><Link href={`/cases/${m.case_id}?tab=plan`}>{m.case_code}</Link> {m.display_name}</td><td className="wrap">{m.agenda}</td><td><Badge tone={m.status === "held" ? "green" : m.status === "scheduled" ? "amber" : "gray"}>{m.status === "held" ? "결과 기록" : m.status === "scheduled" ? "예정" : "취소"}</Badge></td></tr>)}</tbody>
            </table></div>
          )}
        </Panel>
        <Panel title="지원계획 목록" id="plans">
          {d.plans.length === 0 ? <Empty /> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
              <thead><tr><th scope="col">사례</th><th scope="col">대상자</th><th scope="col">버전</th><th scope="col">상태</th><th scope="col" className="num">서비스 항목</th><th scope="col">재검토 예정</th><th scope="col">담당</th><th scope="col">최근 변경</th></tr></thead>
              <tbody>{d.plans.map((p: any) => <tr key={p.id}><td><Link href={`/cases/${p.case_id}?tab=plan`}>{p.case_code}</Link></td><td>{p.display_name}</td><td>v{p.version_no}</td><td><PlanBadge s={p.status} /></td><td className="num">{p.item_count}</td><td>{fmtDate(p.review_date)}</td><td>{p.owner_name}</td><td>{fmtDate(p.updated_at)}</td></tr>)}</tbody>
            </table></div>
          )}
        </Panel>
      </div>
    </>
  );
}
