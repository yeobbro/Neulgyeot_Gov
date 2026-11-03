import Link from "next/link";
import { PageHead, Empty } from "@/components/ui";
import { ActionButton } from "@/components/client/ApiForm";
import { TASK_TYPE_LABEL, type TaskType } from "@/lib/domain/enums";
import { fmtDate, isPast } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { listTasks, refreshMonitoringDue, taskListQuery } from "@/lib/server/services/followup";

export const metadata = { title: "모니터링·후속 업무" };
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = taskListQuery.parse(await searchParams);
  const { rows, isAdmin } = await withPage(async (tx, a) => { await refreshMonitoringDue(tx, a); return { rows: await listTasks(tx, a, q), isAdmin: a.roles.includes("municipal_admin") }; }, { roles: ["municipal_admin", "case_manager"] });
  return (
    <>
      <PageHead title="모니터링 및 후속 업무" desc="모니터링 기한 도래, 방문 예정, 연락 필요, 서비스 미수행·변경, 기관 변경, 사례 종결 검토 업무입니다. 모니터링 주기는 관리자 설정에서 변경합니다." />
      <section className="panel">
        <nav className="tabs" aria-label="업무 필터" style={{ margin: 0, padding: "0 8px" }}>
          <Link href="/tasks" aria-current={q.scope === "mine" && !q.overdue ? "page" : undefined}>내 업무</Link>
          <Link href="/tasks?overdue=1" aria-current={q.overdue === "1" ? "page" : undefined}>기한 초과</Link>
          {isAdmin && <Link href="/tasks?scope=all" aria-current={q.scope === "all" && !q.overdue ? "page" : undefined}>전체(관리자)</Link>}
        </nav>
        {rows.length === 0 ? <Empty>해당 업무 없음</Empty> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
            <thead><tr><th scope="col">기한</th><th scope="col">유형</th><th scope="col" className="wrap">업무</th><th scope="col">대상</th><th scope="col">담당</th><th scope="col">처리</th></tr></thead>
            <tbody>{rows.map((t: any) => <tr key={t.id}><td>{t.due_at ? <span className={isPast(t.due_at) ? "badge b-red" : ""}>{fmtDate(t.due_at)}</span> : "—"}</td><td>{TASK_TYPE_LABEL[t.task_type as TaskType]}</td><td className="wrap">{t.title}</td><td>{t.case_id ? <Link href={`/cases/${t.case_id}`}>{t.case_code}</Link> : t.referral_id ? <Link href={`/referrals/${t.referral_id}`}>{t.receipt_no}</Link> : "—"}</td><td>{t.assignee_name ?? "미배정"}</td><td><ActionButton action={`/api/tasks/${t.id}`} body={{ status: "done" }} label="완료" /></td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
