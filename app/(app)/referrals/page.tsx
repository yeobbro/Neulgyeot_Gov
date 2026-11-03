import Link from "next/link";
import { PageHead, Pager, ReferralBadge, Empty, Badge } from "@/components/ui";
import { REFERRAL_STATUSES, REFERRAL_STATUS_LABEL, type ReferralStatus } from "@/lib/domain/enums";
import { fmtDate } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { listReferrals, referralListQuery } from "@/lib/server/services/referrals";

export const metadata = { title: "병원 연계 신청 접수함" };
const FILTERS: ReferralStatus[] = ["RECEIVED", "UNDER_REVIEW", "NEEDS_INFORMATION", "RESUBMITTED", "ACCEPTED_FOR_ASSESSMENT", "DECLINED", "CLOSED"];

export default async function ReferralsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const q = referralListQuery.parse(sp);
  const data = await withPage((tx, actor) => listReferrals(tx, actor, q), { roles: ["municipal_admin", "case_manager"] });
  const base = `/referrals?${new URLSearchParams({ ...(q.status ? { status: q.status } : {}), ...(q.q ? { q: q.q } : {}) })}`;
  return (
    <>
      <PageHead title="병원 연계 신청 접수함" desc="병원에서 승인된 API 계약(DEMO v1.0)으로 전송된 퇴원·지역연계 신청입니다. 병원 EMR 원문은 수신하지 않습니다." />
      <section className="panel">
        <nav className="tabs" aria-label="접수 상태 필터" style={{ margin: 0, padding: "0 8px" }}>
          <Link href="/referrals" aria-current={!q.status ? "page" : undefined}>전체</Link>
          {FILTERS.map((s) => (
            <Link key={s} href={`/referrals?status=${s}`} aria-current={q.status === s ? "page" : undefined}>
              {REFERRAL_STATUS_LABEL[s]} <span className="badge b-gray">{data.counts[s] ?? 0}</span>
            </Link>
          ))}
        </nav>
        <form className="filters" role="search">
          {q.status && <input type="hidden" name="status" value={q.status} />}
          <div className="field"><label htmlFor="q">접수번호·식별코드·기관 검색</label><input id="q" name="q" type="search" defaultValue={q.q ?? ""} /></div>
          <button className="btn" type="submit">검색</button>
        </form>
        {data.data.length === 0 ? <Empty>조건에 맞는 연계 신청이 없습니다.</Empty> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
            <table className="data">
              <caption>정보 제공 범위: 검증됨 = 동의·법적 근거 확인, 검토 필요 = 일부 항목 열람 제한</caption>
              <thead>
                <tr>
                  <th scope="col">접수번호</th><th scope="col">연계 요청 기관</th><th scope="col">접수일</th><th scope="col">퇴원 예정일</th><th scope="col">대상자 식별 코드</th>
                  <th scope="col">담당 지역</th><th scope="col" className="wrap">요청 서비스</th><th scope="col">정보 제공 범위</th><th scope="col">접수 상태</th><th scope="col">담당자</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((r: any) => (
                  <tr key={r.id}>
                    <td><Link href={`/referrals/${r.id}`}>{r.receipt_no}</Link></td>
                    <td>{r.source_org_name}</td>
                    <td>{fmtDate(r.received_at)}</td>
                    <td>{fmtDate(r.discharge_date)}</td>
                    <td><code>{r.subject_ref}</code></td>
                    <td>{r.region_name ?? <Badge tone="amber">미배정</Badge>}</td>
                    <td className="wrap">{r.requested_services.join(", ") || "—"}</td>
                    <td>{r.consent_check_status === "verified" ? <Badge tone="green">검증됨</Badge> : <Badge tone="amber">검토 필요</Badge>}</td>
                    <td><ReferralBadge s={r.status} /></td>
                    <td>{r.assignee_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} base={base} />
      </section>
      <p className="panel-note" style={{ marginTop: 8 }}>상태 값: {REFERRAL_STATUSES.map((s) => REFERRAL_STATUS_LABEL[s]).join(" · ")}</p>
    </>
  );
}
