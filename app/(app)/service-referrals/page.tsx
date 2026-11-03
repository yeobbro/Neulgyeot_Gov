import Link from "next/link";
import { PageHead, ServiceBadge, Empty } from "@/components/ui";
import { SERVICE_REFERRAL_STATUSES, SERVICE_REFERRAL_STATUS_LABEL, SERVICE_TYPE_LABEL, type ServiceType } from "@/lib/domain/enums";
import { fmtDate } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { listServiceReferrals } from "@/lib/server/services/providers";

export const metadata = { title: "서비스 의뢰·제공 현황" };
export default async function SRPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const rows = await withPage((tx, a) => listServiceReferrals(tx, a, status), { roles: ["municipal_admin", "case_manager"] });
  return (
    <>
      <PageHead title="서비스 의뢰·제공 현황" desc="수행 불가 회신은 사유가 필수이며, 대체 기관 검토 업무가 자동 생성됩니다." />
      <section className="panel">
        <nav className="tabs" aria-label="의뢰 상태 필터" style={{ margin: 0, padding: "0 8px" }}>
          <Link href="/service-referrals" aria-current={!status ? "page" : undefined}>전체</Link>
          {SERVICE_REFERRAL_STATUSES.map((s) => <Link key={s} href={`/service-referrals?status=${s}`} aria-current={status === s ? "page" : undefined}>{SERVICE_REFERRAL_STATUS_LABEL[s]}</Link>)}
        </nav>
        {rows.length === 0 ? <Empty>해당 의뢰 없음</Empty> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
            <thead><tr><th scope="col">의뢰번호</th><th scope="col">사례</th><th scope="col">권역</th><th scope="col">서비스</th><th scope="col">제공기관</th><th scope="col">상태</th><th scope="col">시작 예정</th><th scope="col" className="wrap">수행 불가 사유</th><th scope="col">최근 변경</th></tr></thead>
            <tbody>{rows.map((r: any) => <tr key={r.id}><td>{r.referral_no}</td><td><Link href={`/cases/${r.case_id}?tab=services`}>{r.case_code}</Link></td><td>{r.region_name}</td><td>{SERVICE_TYPE_LABEL[r.service_type as ServiceType]}</td><td>{r.provider_name}</td><td><ServiceBadge s={r.status} /></td><td>{fmtDate(r.scheduled_start)}</td><td className="wrap">{r.unavailable_reason ?? "—"}</td><td>{fmtDate(r.updated_at)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
