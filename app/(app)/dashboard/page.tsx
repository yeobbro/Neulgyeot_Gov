import Link from "next/link";
import { Panel, PageHead, Empty } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { dashboard } from "@/lib/server/services/insights";
import { refreshMonitoringDue, listTasks } from "@/lib/server/services/followup";
import { TASK_TYPE_LABEL, type TaskType } from "@/lib/domain/enums";
import { fmtDate, isPast } from "@/lib/format";

export const metadata = { title: "통합 현황" };

export default async function DashboardPage() {
  const { d, tasks, scope } = await withPage(async (tx, actor) => {
    await refreshMonitoringDue(tx, actor);
    return { d: await dashboard(tx, actor), tasks: await listTasks(tx, actor, { scope: "mine" }), scope: actor.roles.includes("municipal_admin") ? "지자체 전체" : "담당 권역" };
  }, { roles: ["municipal_admin", "case_manager"] });
  return (
    <>
      <PageHead title="통합 현황" desc={<>집계 범위: {scope} · 기준 {fmtDateTime(d.asOf)} · 각 지표를 누르면 해당 목록으로 이동합니다.</>} />
      <section aria-label="업무 지표" className="metrics">
        {d.metrics.map((m) => (
          <Link key={m.key} href={m.href} className={`metric ${"tone" in m && m.tone === "warn" && m.value > 0 ? "warn" : ""}`} title={m.definition} data-testid={`metric-${m.key}`}>
            <div className="label">{m.label}</div>
            <div className="value">{m.value}</div>
            <div className="hint">{m.definition}</div>
          </Link>
        ))}
      </section>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <Panel title="권역별 비교" id="regions" note="담당 권역 범위 내에서만 표시합니다. 데이터가 없는 권역은 0으로 표시합니다.">
          {d.regions.length === 0 ? <Empty /> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
              <table className="data">
                <thead><tr><th scope="col">읍·면·동</th><th scope="col" className="num">관리 사례</th><th scope="col" className="num">모니터링 예정</th><th scope="col" className="num">조치일 경과</th></tr></thead>
                <tbody>{d.regions.map((r) => <tr key={r.region}><td>{r.region}</td><td className="num">{r.open}</td><td className="num">{r.monitoring}</td><td className="num">{r.overdue}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="내 업무 (기한순)" id="mytasks" actions={<Link className="btn btn-sm" href="/tasks">전체 보기</Link>}>
          {tasks.length === 0 ? <Empty>배정된 미완료 업무가 없습니다.</Empty> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
              <table className="data">
                <thead><tr><th scope="col">기한</th><th scope="col">유형</th><th scope="col" className="wrap">업무</th><th scope="col">대상</th></tr></thead>
                <tbody>
                  {tasks.slice(0, 8).map((t: any) => (
                    <tr key={t.id}>
                      <td>{t.due_at ? <span className={isPast(t.due_at) ? "badge b-red" : ""}>{fmtDate(t.due_at)}</span> : "—"}</td>
                      <td>{TASK_TYPE_LABEL[t.task_type as TaskType]}</td>
                      <td className="wrap">{t.title}</td>
                      <td>{t.case_id ? <Link href={`/cases/${t.case_id}`}>{t.case_code}</Link> : t.referral_id ? <Link href={`/referrals/${t.referral_id}`}>{t.receipt_no}</Link> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
