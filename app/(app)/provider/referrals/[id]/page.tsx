import { PageHead, Panel, ServiceBadge } from "@/components/ui";
import { ApiForm } from "@/components/client/ApiForm";
import { SERVICE_REFERRAL_STATUS_LABEL, SERVICE_TYPE_LABEL, type ServiceReferralStatus, type ServiceType } from "@/lib/domain/enums";
import { fmtDate, fmtDateTime, todayKst } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { providerReferralDetail } from "@/lib/server/services/providers";

export const metadata = { title: "의뢰 상세" };
const LABEL: Partial<Record<ServiceReferralStatus, string>> = { ACCEPTED: "의뢰 수락", UNAVAILABLE: "수행 불가 회신", SCHEDULED: "일정 등록", STARTED: "서비스 시작", COMPLETED: "수행 결과 제출(완료)", REASSESSMENT_REQUIRED: "재방문·재연계 요청" };
export default async function ProviderReferral({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await withPage((tx, a) => providerReferralDetail(tx, a, id), { roles: ["service_provider"] });
  const r = d.referral as any;
  return (
    <>
      <PageHead crumbs={[{ href: "/provider", label: "의뢰 수신함" }]} title={`${r.referral_no} · ${SERVICE_TYPE_LABEL[r.service_type as ServiceType]}`} desc={<><ServiceBadge s={r.status} /> · 의뢰 {fmtDateTime(r.requested_at)} · 의뢰 담당 {r.requested_by_name}</>} />
      <div className="split">
        <div className="stack">
          <Panel title="의뢰 내용" id="req" note="서비스 제공에 필요한 최소 정보만 제공됩니다.">
            <dl className="kv">
              <dt>사례 코드</dt><dd>{r.case_code}</dd><dt>대상자(가명)</dt><dd>{r.recipient_alias} · {r.age_band ?? "연령대 미기재"}</dd><dt>권역</dt><dd>{r.region_name}</dd>
              <dt>제공 주기</dt><dd>{r.frequency}</dd><dt>수행 방법</dt><dd>{r.method || "—"}</dd><dt>계획 기간</dt><dd>{fmtDate(r.start_date)} ~ {fmtDate(r.end_date)}</dd>
              <dt>의뢰 메모</dt><dd style={{ whiteSpace: "pre-wrap" }}>{r.request_note}</dd><dt>시작 예정일</dt><dd>{fmtDate(r.scheduled_start)}</dd>
              <dt>기관 회신</dt><dd>{r.unavailable_reason ?? r.provider_note ?? "—"}</dd>
            </dl>
          </Panel>
          <Panel title="처리 이력" id="hist">
            <ol className="timeline">{d.events.map((e: any, i: number) => <li key={i}><time>{fmtDateTime(e.at)}</time>{e.from_status ? `${SERVICE_REFERRAL_STATUS_LABEL[e.from_status as ServiceReferralStatus]} → ` : ""}<strong>{SERVICE_REFERRAL_STATUS_LABEL[e.to_status as ServiceReferralStatus]}</strong> · {e.actor_kind === "provider" ? "제공기관" : "지자체"}{e.note ? ` — ${e.note}` : ""}</li>)}</ol>
          </Panel>
        </div>
        <Panel title="회신·결과 등록" id="act">
          {d.allowed.length === 0 ? <p className="panel-note">현재 상태에서 기관이 처리할 단계가 없습니다.</p> : (
            <div className="stack">
              {d.allowed.map((t) => (
                <details key={t} className="disclosure" open={d.allowed.length === 1 || t === "ACCEPTED"}>
                  <summary>{LABEL[t] ?? SERVICE_REFERRAL_STATUS_LABEL[t]}</summary>
                  <div>
                    <ApiForm action={`/api/service-referrals/${id}/transition`} submitLabel={LABEL[t] ?? "저장"} danger={t === "UNAVAILABLE"} extra={{ to: t, expectedVersion: r.version }} testId={`pv-${t}`}
                      fields={
                        t === "UNAVAILABLE" ? [{ name: "unavailableReason", label: "수행 불가 사유", type: "textarea", required: true }]
                        : t === "SCHEDULED" ? [{ name: "scheduledStart", label: "서비스 시작 예정일", type: "date", required: true, defaultValue: todayKst() }, { name: "note", label: "일정 메모", type: "text" }]
                        : t === "COMPLETED" || t === "REASSESSMENT_REQUIRED" ? [{ name: "note", label: t === "COMPLETED" ? "수행 결과" : "재방문·재연계 사유", type: "textarea", required: true }]
                        : [{ name: "note", label: "메모", type: "text" }]
                      } />
                  </div>
                </details>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
