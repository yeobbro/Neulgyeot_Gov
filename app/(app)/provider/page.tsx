import Link from "next/link";
import { PageHead, ServiceBadge, Empty } from "@/components/ui";
import { SERVICE_TYPE_LABEL, type ServiceType } from "@/lib/domain/enums";
import { fmtDate } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { providerInbox } from "@/lib/server/services/providers";

export const metadata = { title: "의뢰 수신함" };
export default async function ProviderInbox() {
  const rows = await withPage((tx, a) => providerInbox(tx, a), { roles: ["service_provider"] });
  return (
    <>
      <PageHead title="서비스 의뢰 수신함" desc="우리 기관으로 전달된 의뢰만 표시됩니다. 대상자 실명·지자체 내부 메모는 제공되지 않습니다." />
      <section className="panel">
        {rows.length === 0 ? <Empty>수신된 의뢰 없음</Empty> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
            <thead><tr><th scope="col">의뢰번호</th><th scope="col">사례 코드</th><th scope="col">권역</th><th scope="col">서비스</th><th scope="col">주기</th><th scope="col">상태</th><th scope="col">의뢰일</th><th scope="col">시작 예정</th></tr></thead>
            <tbody>{rows.map((r: any) => <tr key={r.id}><td><Link href={`/provider/referrals/${r.id}`}>{r.referral_no}</Link></td><td>{r.case_code}</td><td>{r.region_name}</td><td>{SERVICE_TYPE_LABEL[r.service_type as ServiceType]}</td><td>{r.frequency}</td><td><ServiceBadge s={r.status} /></td><td>{fmtDate(r.requested_at)}</td><td>{fmtDate(r.scheduled_start)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
