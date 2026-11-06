import Link from "next/link";
import { PageHead, Panel, ReferralBadge, Badge, Empty } from "@/components/ui";
import { ApiForm } from "@/components/client/ApiForm";
import { AiDraftPanel } from "@/components/client/AiDraftPanel";
import { REFERRAL_STATUS_LABEL, type ReferralStatus } from "@/lib/domain/enums";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { getReferral } from "@/lib/server/services/referrals";
import { listCaseManagers, listRegions } from "@/lib/server/services/admin";
import { listDraftGroups } from "@/lib/server/services/ai-review";

export const metadata = { title: "연계 신청 상세" };
const RETENTION: Record<string, string> = { untilCaseClosure: "연계 종결 시까지", oneYear: "수신일로부터 1년", threeYears: "수신일로부터 3년" };
const DECISION: Record<string, [string, "green" | "amber" | "gray"]> = { accepted: ["수신·활용", "green"], pending_review: ["검토 전 열람 제한", "amber"], blocked_by_policy: ["정책상 미수신", "gray"] };

function Payload({ p }: { p: any }) {
  if (!p) return <Empty>저장된 데이터 없음</Empty>;
  const fs = p.functionalSummary ?? {};
  const ln = p.livingNeeds;
  return (
    <dl className="kv">
      <dt>퇴원 예정일</dt><dd>{p.discharge?.plannedDate ?? "제공되지 않음"}</dd>
      <dt>일상생활 기능</dt><dd>{typeof fs.kAdl === "object" ? `식사 ${fs.kAdl.eating} · 이동 ${fs.kAdl.mobility} · 화장실 ${fs.kAdl.toileting}` : fs.kAdl ?? "제공되지 않음"}</dd>
      <dt>인지·의사소통</dt><dd>{fs.cognition ?? "제공되지 않음"}</dd>
      <dt>낙상 위험 구간</dt><dd>{fs.fallRisk ?? "제공되지 않음"}</dd>
      <dt>동거 형태</dt><dd>{ln?.livingArrangement ?? "제공되지 않음"}</dd>
      <dt>주거 형태</dt><dd>{ln?.housingType ?? "제공되지 않음"}</dd>
      <dt>주거 장애요인</dt><dd>{ln?.barriers?.join(", ") || "제공되지 않음"}</dd>
      <dt>요청 서비스</dt><dd>{ln?.requestedServices?.join(", ") || "제공되지 않음"}</dd>
      <dt>사회복지사 소견</dt><dd>{ln?.socialWorkerNote ?? "제공되지 않음"}</dd>
    </dl>
  );
}

export default async function ReferralDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { d, managers, regions, isAdmin, groups, aiEnabled, canAct } = await withPage(async (tx, actor) => {
    const d = await getReferral(tx, actor, id);
    const [s] = await tx.query<{ ai_enabled: boolean }>(`SELECT ai_enabled FROM tenant_settings WHERE tenant_id = $1`, [actor.tenantId]);
    const isAdmin = actor.roles.includes("municipal_admin");
    return {
      d, isAdmin, managers: await listCaseManagers(tx), regions: (await listRegions(tx)).filter((r) => r.level === "eupmyeondong"),
      groups: await listDraftGroups(tx, { referralId: id }), aiEnabled: Boolean(s?.ai_enabled), // read access checked by getReferral above
      canAct: isAdmin || (d.referral as any).assigned_user_id === actor.id,
    };
  }, { roles: ["municipal_admin", "case_manager"] });
  const r = d.referral as any;
  const status = r.status as ReferralStatus;
  const transitions = d.allowedTransitions.filter((t) => t !== "ACCEPTED_FOR_ASSESSMENT");
  return (
    <>
      <PageHead
        crumbs={[{ href: "/referrals", label: "병원 연계 접수함" }]}
        title={`${r.receipt_no} · ${r.subject_display}`}
        desc={<>원본 기관 {r.source_org_name} · 전송 {fmtDateTime(r.received_at)} · <ReferralBadge s={status} /></>}
        actions={r.case_id ? <Link className="btn btn-primary" href={`/cases/${r.case_id}`}>연결된 사례 보기</Link> : null}
      />
      {r.consent_check_status !== "verified" && <div className="alert alert-warn" style={{ marginBottom: 12 }}>법적 근거 검토가 끝나지 않은 항목이 있습니다. 해당 항목은 열람·활용이 제한되며, 검토 완료 전에는 사례로 접수할 수 없습니다.</div>}
      <div className="split">
        <div className="stack">
          <Panel title="연계 요청 요약" id="summary">
            <dl className="kv">
              <dt>접수번호</dt><dd>{r.receipt_no}</dd>
              <dt>대상자 식별 코드</dt><dd><code>{r.subject_ref}</code> <small className="panel-note">(병원 환자번호를 변환한 외부 참조값)</small></dd>
              <dt>담당 지역</dt><dd>{r.region_name ?? "미배정"}</dd>
              <dt>담당자</dt><dd>{r.assignee_name ?? "미배정"}</dd>
              <dt>퇴원 예정일</dt><dd>{fmtDate(r.discharge_date)}</dd>
              <dt>요청 서비스</dt><dd>{r.requested_services.join(", ") || "—"}</dd>
              <dt>자료 누락 여부</dt><dd>{r.missing_items.length ? r.missing_items.map((m: string) => <Badge key={m} tone="amber">{m}</Badge>) : <Badge tone="green">누락 항목 없음</Badge>}</dd>
            </dl>
          </Panel>
          <Panel title="제공된 정보 항목 (최신 버전)" id="payload" note="병원의 전체 EMR·간호기록·전체 투약 목록은 수신하지 않습니다. 정책상 미수신 항목은 저장되지 않습니다.">
            <Payload p={d.payload} />
          </Panel>
          <Panel title="동의·법적 근거 확인 메타데이터" id="consent">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
              <table className="data">
                <thead><tr><th scope="col">항목</th><th scope="col">민감정보</th><th scope="col">처리</th><th scope="col" className="wrap">사유</th><th scope="col" className="wrap">목적</th><th scope="col">보유기간</th><th scope="col" className="wrap">법적 근거</th><th scope="col">별도동의</th><th scope="col">동의 기록일시</th></tr></thead>
                <tbody>
                  {d.consent.map((c: any) => (
                    <tr key={c.category}>
                      <td>{c.label}</td><td>{c.sensitive ? "예" : "아니오"}</td>
                      <td><Badge tone={DECISION[c.decision][1]}>{DECISION[c.decision][0]}</Badge></td>
                      <td className="wrap">{c.reason}</td><td className="wrap">{c.purpose ?? "—"}</td><td>{RETENTION[c.retention] ?? c.retention}</td>
                      <td className="wrap">{c.legal_basis ?? "기재 없음"}</td><td>{c.separate_consent_status}</td><td>{fmtDateTime(c.consent_recorded_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {isAdmin && d.consent.some((c: any) => c.decision === "pending_review") && (
              <div style={{ marginTop: 12 }}>
                <ApiForm action={`/api/referrals/${id}/consent-review`} submitLabel="법적 근거 확인 기록" fields={[
                  { name: "category", label: "검토 항목", type: "select", required: true, options: d.consent.filter((c: any) => c.decision === "pending_review").map((c: any) => ({ value: c.category, label: c.label })) },
                  { name: "legalBasisNote", label: "확인한 법적 근거", type: "text", required: true, placeholder: "예: 정보주체 별도 동의서 확인(개인정보 보호법 제23조)" },
                ]} />
              </div>
            )}
          </Panel>
          <Panel title="AI 연계 신청 요약 (검토용)" id="ai">
            <AiDraftPanel target={{ referralId: id }} kinds={["referral_summary"]} groups={groups as any} canWrite={canAct} aiEnabled={aiEnabled} />
          </Panel>
        </div>
        <div className="stack">
          {canAct && status !== "CLOSED" && (
            <Panel title="처리" id="actions">
              <div className="stack">
                {isAdmin && (
                  <details className="disclosure" open={!r.assigned_user_id}>
                    <summary>담당자·지역 배정</summary>
                    <div>
                      <ApiForm action={`/api/referrals/${id}/assign`} submitLabel="배정" testId="assign-form" fields={[
                        { name: "regionUnitId", label: "담당 지역", type: "select", required: true, defaultValue: r.region_unit_id ?? "", options: regions.map((g) => ({ value: g.id, label: g.name })) },
                        { name: "userId", label: "담당자", type: "select", required: true, defaultValue: r.assigned_user_id ?? "", options: managers.map((m) => ({ value: m.id, label: m.display_name })) },
                      ]} />
                    </div>
                  </details>
                )}
                {(status === "UNDER_REVIEW") && (
                  <details className="disclosure">
                    <summary>사례 생성(접수 완료·조사 예정)</summary>
                    <div>
                      <p className="panel-note" style={{ marginBottom: 8 }}>대상자 표시명은 업무용 가명으로 입력합니다. 실명·생년월일은 식별정보 저장소에 분리 보관됩니다.</p>
                      <ApiForm action={`/api/referrals/${id}/accept`} submitLabel="사례 생성" redirectTo="/cases/{caseId}" testId="accept-form" fields={[
                        { name: "displayName", label: "대상자 표시명(가명)", type: "text", required: true, defaultValue: `연계 ${r.receipt_no.slice(-4)}` },
                        { name: "ageBand", label: "연령대", type: "select", options: ["60대", "70대", "80대", "90대 이상"].map((v) => ({ value: v, label: v })) },
                      ]} />
                    </div>
                  </details>
                )}
                {transitions.includes("NEEDS_INFORMATION") && (
                  <details className="disclosure">
                    <summary>추가 정보 요청</summary>
                    <div>
                      <ApiForm action={`/api/referrals/${id}/transition`} submitLabel="보완 요청 전송" extra={{ to: "NEEDS_INFORMATION" }} fields={[
                        { name: "missingItems", label: "요청 항목 (줄마다 1개)", type: "lines", required: true },
                        { name: "note", label: "메모", type: "text" },
                      ]} />
                    </div>
                  </details>
                )}
                {transitions.includes("DECLINED") && (
                  <details className="disclosure">
                    <summary>반려</summary>
                    <div>
                      <ApiForm action={`/api/referrals/${id}/transition`} submitLabel="반려" danger extra={{ to: "DECLINED" }} fields={[{ name: "declineReason", label: "반려 사유", type: "textarea", required: true }]} />
                    </div>
                  </details>
                )}
                {transitions.filter((t) => ["UNDER_REVIEW", "CLOSED"].includes(t)).map((t) => (
                  <ApiForm key={t} action={`/api/referrals/${id}/transition`} inline submitLabel={`${REFERRAL_STATUS_LABEL[t]}(으)로 변경`} extra={{ to: t }} fields={[{ name: "note", label: "메모", type: "text" }]} />
                ))}
              </div>
            </Panel>
          )}
          <Panel title="연계 기술 정보" id="tech">
            <dl className="kv">
              <dt>transferId</dt><dd><code>{r.transfer_id}</code></dd>
              <dt>traceId</dt><dd><code>{r.trace_id}</code></dd>
              <dt>schemaVersion</dt><dd>{r.schema_version} <small className="panel-note">(DEMO 계약, 공공 표준 아님)</small></dd>
              <dt>검증 결과</dt><dd>{r.validation?.ok ? <Badge tone="green">스키마 통과</Badge> : <Badge tone="red">실패</Badge>}</dd>
              <dt>수신 버전</dt><dd>{d.versions.map((v: any) => `v${v.version_no} (${fmtDateTime(v.received_at)}, #${v.payload_hash})`).join(" · ")}</dd>
            </dl>
          </Panel>
          <Panel title="상태 변경·추가 자료 요청 이력" id="history">
            <ol className="timeline">
              {d.events.map((e: any, i: number) => (
                <li key={i}><time>{fmtDateTime(e.at)}</time><strong>{e.from_status ? `${REFERRAL_STATUS_LABEL[e.from_status as ReferralStatus] ?? e.from_status} → ` : ""}{REFERRAL_STATUS_LABEL[e.to_status as ReferralStatus] ?? e.to_status}</strong> · {e.actor_label}{e.note ? <div>{e.note}</div> : null}</li>
              ))}
            </ol>
          </Panel>
          <Panel title="연계 메시지 로그" id="messages" note="본문 없이 메타데이터만 기록합니다. 병원 방향 상태 통지는 mock adapter로 대기열에만 기록됩니다.">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
              <table className="data"><thead><tr><th scope="col">시각</th><th scope="col">방향</th><th scope="col">종류</th><th scope="col">결과</th></tr></thead>
                <tbody>{d.messages.map((m: any, i: number) => <tr key={i}><td>{fmtDateTime(m.at)}</td><td>{m.direction === "inbound" ? "수신" : "발신"}</td><td>{m.kind}</td><td>{m.http_status ?? m.delivery_status}{m.error_code ? ` (${m.error_code})` : ""}</td></tr>)}</tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
