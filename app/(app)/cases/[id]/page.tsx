import Link from "next/link";
import { PageHead, Panel, Tabs, CaseBadge, PlanBadge, ServiceBadge, Badge, Empty, DemoTag } from "@/components/ui";
import { ApiForm, ActionButton } from "@/components/client/ApiForm";
import { AssessmentEditor } from "@/components/client/AssessmentEditor";
import { PlanEditor } from "@/components/client/PlanEditor";
import { MatchPanel } from "@/components/client/MatchPanel";
import { AiDraftPanel } from "@/components/client/AiDraftPanel";
import { IdentityReveal } from "@/components/client/IdentityReveal";
import {
  ASSESSMENT_KIND_LABEL, ASSESSMENT_STATUS_LABEL, CASE_STATUS_LABEL, INTAKE_ROUTE_LABEL, MONITORING_METHOD_LABEL, PLAN_STATUS_LABEL, RECORD_TYPES, RECORD_TYPE_LABEL,
  SERVICE_REFERRAL_STATUS_LABEL, SERVICE_REFERRAL_TRANSITIONS, SERVICE_TRANSITION_ACTOR, SERVICE_TYPE_LABEL, TASK_TYPE_LABEL,
  type AssessmentKind, type CaseStatus, type IntakeRoute, type MonitoringMethod, type PlanStatus, type RecordType, type ServiceReferralStatus, type ServiceType, type TaskType,
} from "@/lib/domain/enums";
import { fmtDate, fmtDateTime, isPast, nowKstLocal } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { getAssessment, getCase, listRecords } from "@/lib/server/services/cases";
import { getPlans } from "@/lib/server/services/plans";
import { listServiceReferralsForCase } from "@/lib/server/services/providers";
import { caseTimeline, listMonitoring } from "@/lib/server/services/followup";
import { listDraftGroups } from "@/lib/server/services/ai-review";
import { listCaseManagers } from "@/lib/server/services/admin";

export const metadata = { title: "사례 상세" };
const TABS = [
  ["overview", "기본 정보"], ["assessment", "조사·평가"], ["plan", "지원계획·회의"], ["services", "서비스 연계"], ["monitoring", "모니터링"], ["records", "상담 기록"], ["timeline", "업무 타임라인"], ["ai", "AI 보조"],
] as const;
const DEPT: Record<string, string> = {
  visiting_nursing: "보건소 방문보건팀", visiting_health: "보건소 방문보건팀", home_medical_link: "보건소 의약과", meal: "복지정책과", mobility: "교통행정과", housework: "노인복지과",
  home_modification: "건축과·주거복지팀", home_care: "노인복지과", ltc_link: "통합돌봄과", cognitive_emotional: "치매안심센터", social_participation: "노인복지과", family_caregiver: "가족정책과", local_special: "통합돌봄과",
};
const TIMELINE_KIND: Record<string, string> = { record: "상담 기록", monitoring: "모니터링", service: "서비스 의뢰", plan: "지원계획", meeting: "통합지원회의", assessment: "조사·평가", status: "사례 상태 변경" };

export default async function CaseDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const tab = (await searchParams).tab ?? "overview";
  const data = await withPage(async (tx, actor) => {
    const base = await getCase(tx, actor, id);
    const isAdmin = actor.roles.includes("municipal_admin");
    const out: Record<string, unknown> = { base, isAdmin, canWrite: isAdmin || base.access.assigned, canConfirmOfficial: actor.canConfirmOfficialDetermination };
    if (tab === "overview" && isAdmin) out.managers = await listCaseManagers(tx);
    if (tab === "assessment") out.assessment = await getAssessment(tx, actor, id);
    if (tab === "plan" || tab === "services") out.plans = await getPlans(tx, actor, id);
    if (tab === "services") out.services = await listServiceReferralsForCase(tx, actor, id);
    if (tab === "monitoring") out.monitoring = await listMonitoring(tx, actor, id);
    if (tab === "records") out.records = await listRecords(tx, actor, id);
    if (tab === "timeline") out.timeline = await caseTimeline(tx, actor, id);
    if (tab === "ai") {
      const [s] = await tx.query<{ ai_enabled: boolean }>(`SELECT ai_enabled FROM tenant_settings WHERE tenant_id = $1`, [actor.tenantId]);
      out.groups = await listDraftGroups(tx, { caseId: id }); // read access checked by getCase above
      out.aiEnabled = Boolean(s?.ai_enabled);
    }
    return out;
  }, { roles: ["municipal_admin", "case_manager"] });
  const base = data.base as Awaited<ReturnType<typeof getCase>>;
  const c = base.case as any;
  const canWrite = data.canWrite as boolean;
  const isAdmin = data.isAdmin as boolean;
  const href = (t: string) => `/cases/${id}?tab=${t}`;
  return (
    <>
      <PageHead
        crumbs={[{ href: "/cases", label: "사례관리" }]}
        title={`${c.case_code} · ${c.display_name}`}
        desc={<>{c.region_name} · {INTAKE_ROUTE_LABEL[c.intake_route as IntakeRoute]} · 담당 {c.worker_name ?? "미배정"} · <CaseBadge s={c.status} /> {c.is_synthetic && <DemoTag />}</>}
        actions={!canWrite ? <Badge tone="amber">열람 전용 (배정되지 않은 사례)</Badge> : null}
      />
      <Tabs current={tab} items={TABS.map(([k, l]) => ({ key: k, label: l, href: href(k) }))} />

      {tab === "overview" && (
        <div className="split">
          <div className="stack">
            <Panel title="기본 정보" id="basic" note="의료 진단·약물 정보는 일반 사례 화면에 표시하지 않습니다.">
              <dl className="kv">
                <dt>사례 코드</dt><dd>{c.case_code}</dd>
                <dt>대상자 코드</dt><dd>{c.recipient_code}</dd>
                <dt>표시명(가명)</dt><dd>{c.display_name}</dd>
                <dt>연령대</dt><dd>{c.age_band ?? "확인 필요"}</dd>
                <dt>가구 형태</dt><dd>{c.household_type ?? "확인 필요"}</dd>
                <dt>담당 권역</dt><dd>{c.region_name}</dd>
                <dt>사례 개시</dt><dd>{fmtDate(c.opened_at)}</dd>
                <dt>최근 상담일</dt><dd>{fmtDate(c.last_contact_at)}</dd>
                <dt>다음 후속 조치</dt><dd>{c.next_action_at ? `${fmtDate(c.next_action_at)} ${c.next_action_label ?? ""}` : "—"}</dd>
                {c.closed_at && <><dt>종결</dt><dd>{fmtDate(c.closed_at)} · {c.closure_reason}</dd></>}
              </dl>
            </Panel>
            <Panel title="신청 경로 및 신청 이력" id="apps">
              <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
                <thead><tr><th scope="col">신청번호</th><th scope="col">경로</th><th scope="col">접수일</th><th scope="col" className="wrap">요지</th><th scope="col">연계</th></tr></thead>
                <tbody>{base.applications.map((a: any) => <tr key={a.application_no}><td>{a.application_no}</td><td>{INTAKE_ROUTE_LABEL[a.route as IntakeRoute]}</td><td>{fmtDate(a.received_at)}</td><td className="wrap">{a.summary || "—"}</td><td>{a.referral_id ? <Link href={`/referrals/${a.referral_id}`}>{a.receipt_no}</Link> : "—"}</td></tr>)}</tbody>
              </table></div>
            </Panel>
            <Panel title="미완료 업무" id="tasks">
              {base.tasks.length === 0 ? <Empty>미완료 업무 없음</Empty> : (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
                  <thead><tr><th scope="col">기한</th><th scope="col">유형</th><th scope="col" className="wrap">업무</th><th scope="col">처리</th></tr></thead>
                  <tbody>{base.tasks.map((t: any) => <tr key={t.id}><td>{t.due_at ? <span className={isPast(t.due_at) ? "badge b-red" : ""}>{fmtDate(t.due_at)}</span> : "—"}</td><td>{TASK_TYPE_LABEL[t.task_type as TaskType]}</td><td className="wrap">{t.title}</td><td>{canWrite && <ActionButton action={`/api/tasks/${t.id}`} body={{ status: "done" }} label="완료" />}</td></tr>)}</tbody>
                </table></div>
              )}
            </Panel>
          </div>
          <div className="stack">
            <Panel title="담당 배정" id="assign">
              <ul style={{ margin: 0, paddingLeft: 16 }}>{base.assignments.map((a: any) => <li key={a.user_id}>{a.display_name} ({a.assignment_role === "primary" ? "주 담당" : "부 담당"}) · {fmtDate(a.assigned_at)}</li>)}</ul>
              {isAdmin && (
                <div style={{ marginTop: 10 }}>
                  <ApiForm action={`/api/cases/${id}/assign`} inline submitLabel="담당자 변경" fields={[{ name: "userId", label: "주 담당자", type: "select", required: true, defaultValue: c.primary_worker_id ?? "", options: ((data.managers as any[]) ?? []).map((m) => ({ value: m.id, label: m.display_name })) }]} />
                </div>
              )}
            </Panel>
            {canWrite && base.allowedTransitions.length > 0 && (
              <Panel title="사례 상태 변경" id="status" note="상태 전이는 서버 규칙으로 검증됩니다. 종결·철회는 사유가 필요합니다.">
                <ApiForm action={`/api/cases/${id}/status`} submitLabel="상태 변경" testId="case-status-form" fields={[
                  { name: "to", label: "변경할 상태", type: "select", required: true, options: base.allowedTransitions.map((s) => ({ value: s, label: CASE_STATUS_LABEL[s as CaseStatus] })) },
                  { name: "reason", label: "사유", type: "text", maxLength: 300 },
                ]} />
              </Panel>
            )}
            {canWrite && <Panel title="식별정보" id="identity"><IdentityReveal caseId={id} /></Panel>}
          </div>
        </div>
      )}

      {tab === "assessment" && (() => {
        const a = data.assessment as Awaited<ReturnType<typeof getAssessment>>;
        const cur = a.current;
        return (
          <div className="stack">
            <Panel title="조사 및 통합 욕구 평가" id="asm" actions={cur ? <><Badge tone="blue">{ASSESSMENT_KIND_LABEL[cur.kind as AssessmentKind]}</Badge><Badge tone={cur.status === "confirmed" ? "green" : cur.status === "submitted" ? "amber" : "gray"}>{ASSESSMENT_STATUS_LABEL[cur.status as keyof typeof ASSESSMENT_STATUS_LABEL]}</Badge></> : null}
              note="이 화면은 지자체 자체조사입니다. 제도상 통합판정은 권한이 부여된 담당자만 확정할 수 있으며, 이 시스템은 법정 판정을 대체하지 않습니다.">
              <div className="row" style={{ marginBottom: 10 }}>
                <Badge tone="green">확인됨 {a.summary.confirmed}</Badge><Badge tone="amber">추가 확인 필요 {a.summary.needs_followup}</Badge>
                <Badge tone="gray">확인되지 않음 {a.summary.unconfirmed}</Badge><Badge tone="red">무응답 {a.summary.no_response}</Badge><Badge tone="gray">미기재 {a.summary.missing}</Badge>
                {cur && <span className="panel-note">조사자 {cur.surveyor_name} · {cur.confirmed_at ? `확정 ${fmtDateTime(cur.confirmed_at)} (${cur.confirmer_name})` : "미확정"}</span>}
              </div>
              <AssessmentEditor caseId={id} assessmentId={cur?.id ?? null} version={cur?.version ?? null} status={cur?.status ?? null}
                items={a.items.map((i) => ({ domain: i.domain, answerStatus: i.answer_status, value: i.value, note: i.note }))}
                home={a.home ? { housingType: (a.home as any).housing_type, barriers: (a.home as any).barriers ?? [], heatingCooling: (a.home as any).heating_cooling, safetyNotes: (a.home as any).safety_notes ?? "", modificationNeeded: (a.home as any).modification_needed } : null}
                canWrite={canWrite} canConfirm={canWrite && (cur?.kind !== "official_determination" || Boolean(data.canConfirmOfficial))} />
            </Panel>
          </div>
        );
      })()}

      {tab === "plan" && (() => {
        const p = data.plans as Awaited<ReturnType<typeof getPlans>>;
        const cur = p.current as any;
        const editable = canWrite && (!cur || ["DRAFT", "NEEDS_REVISION"].includes(cur.status));
        const newVersion = canWrite && cur && ["CHANGE_REVIEW", "CLOSED"].includes(cur.status);
        return (
          <div className="split">
            <div className="stack">
              <Panel title={cur ? `개인별 지원계획 v${cur.version_no}` : "개인별 지원계획"} id="plan" actions={cur ? <PlanBadge s={cur.status} /> : null}>
                {editable || newVersion ? (
                  <PlanEditor caseId={id} departments={DEPT} initial={editable && cur ? {
                    planId: cur.id, expectedVersion: cur.version, goals: cur.goals, mainNeeds: cur.main_needs, recipientWishes: cur.recipient_wishes, additionalChecks: cur.additional_checks,
                    startDate: cur.start_date ? fmtDate(cur.start_date) : null, reviewDate: cur.review_date ? fmtDate(cur.review_date) : null,
                    items: p.items.map((i: any) => ({ id: i.id, serviceType: i.service_type, department: i.department, providerId: i.provider_id, frequency: i.frequency, startDate: i.start_date ? fmtDate(i.start_date) : null, endDate: i.end_date ? fmtDate(i.end_date) : null, method: i.method, notes: i.notes })),
                  } : { goals: cur?.goals ?? "", mainNeeds: cur?.main_needs ?? "", recipientWishes: cur?.recipient_wishes ?? "", additionalChecks: "", startDate: null, reviewDate: null, items: [] }} />
                ) : cur ? (
                  <>
                    <dl className="kv">
                      <dt>지원 목표</dt><dd>{cur.goals}</dd><dt>주요 욕구</dt><dd>{cur.main_needs}</dd><dt>대상자 희망</dt><dd>{cur.recipient_wishes || "—"}</dd>
                      <dt>추가 확인 항목</dt><dd>{cur.additional_checks || "—"}</dd><dt>기간</dt><dd>{fmtDate(cur.start_date)} ~ {fmtDate(cur.review_date)} (재검토)</dd>
                      <dt>담당자</dt><dd>{cur.owner_name}</dd><dt>승인</dt><dd>{cur.approved_at ? `${cur.approver_name} · ${fmtDateTime(cur.approved_at)} · 근거: ${cur.approval_basis}` : "미승인"}</dd>
                    </dl>
                    <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)" style={{ marginTop: 12 }}><table className="data">
                      <thead><tr><th scope="col">서비스</th><th scope="col">담당 부서</th><th scope="col">제공기관</th><th scope="col">주기</th><th scope="col">기간</th><th scope="col">의뢰 상태</th></tr></thead>
                      <tbody>{p.items.map((i: any) => <tr key={i.id}><td>{SERVICE_TYPE_LABEL[i.service_type as ServiceType]}</td><td>{i.department}</td><td>{i.provider_name ?? "미정"}</td><td>{i.frequency}</td><td>{fmtDate(i.start_date)}~{fmtDate(i.end_date)}</td><td>{i.referral_status ? <ServiceBadge s={i.referral_status} /> : "미의뢰"}</td></tr>)}</tbody>
                    </table></div>
                  </>
                ) : <Empty>작성된 지원계획이 없습니다.</Empty>}
              </Panel>
              <Panel title="통합지원회의" id="meetings">
                {p.meetings.length === 0 ? <Empty>등록된 회의 없음</Empty> : p.meetings.map((m: any) => (
                  <article key={m.id} className="panel" style={{ marginBottom: 10 }}>
                    <div className="panel-head"><h3>{fmtDateTime(m.scheduled_at)} · {m.agenda}</h3><Badge tone={m.status === "held" ? "green" : m.status === "scheduled" ? "amber" : "gray"}>{m.status === "held" ? "결과 기록됨" : m.status === "scheduled" ? "예정" : "취소"}</Badge></div>
                    <div className="panel-body stack">
                      <p><strong>참석 조직:</strong> {(m.participants ?? []).map((x: any) => `${x.organization}(${x.role}${x.attended === false ? ", 불참" : ""})`).join(", ")}</p>
                      {m.status === "held" && <dl className="kv"><dt>확인된 사실</dt><dd>{m.confirmed_facts}</dd><dt>추가 검토 사항</dt><dd>{m.open_questions || "—"}</dd><dt>회의 결과</dt><dd>{m.outcome}</dd><dt>결정</dt><dd>{(m.decisions ?? []).map((d: any, i: number) => <div key={i}>{d.decision === "approve_plan" ? "계획 승인 권고" : d.decision === "revise_plan" ? "계획 보완" : "보류"}: {d.content} ({d.decided_by}, {fmtDateTime(d.decided_at)})</div>)}</dd><dt>기록</dt><dd>{fmtDateTime(m.recorded_at)}</dd></dl>}
                      {m.status === "scheduled" && canWrite && (
                        <details className="disclosure"><summary>회의 결과 기록</summary><div>
                          <ApiForm action={`/api/cases/${id}/meetings/${m.id}/record`} submitLabel="회의 결과 저장" testId="meeting-record-form" fields={[
                            { name: "confirmedFacts", label: "확인된 사실", type: "textarea", required: true },
                            { name: "openQuestions", label: "추가 검토 사항", type: "textarea" },
                            { name: "outcome", label: "회의 결과", type: "textarea", required: true },
                            { name: "decision", label: "지원계획 결정", type: "select", required: true, options: [{ value: "approve_plan", label: "계획 승인 권고" }, { value: "revise_plan", label: "계획 보완 요구" }, { value: "defer", label: "보류(재논의)" }] },
                            { name: "decisionContent", label: "결정 내용", type: "textarea", required: true },
                          ]} />
                        </div></details>
                      )}
                    </div>
                  </article>
                ))}
              </Panel>
            </div>
            <div className="stack">
              {cur && (
                <Panel title="계획 진행" id="plan-actions" note="승인은 원클릭이 아닌 근거 기록이 필요한 단계입니다. 승인 권한은 지자체 정책 설정을 따릅니다.">
                  <div className="stack">
                    {canWrite && p.allowedTransitions.filter((t) => !["APPROVED", "MEETING_SCHEDULED", "REFERRING", "IN_PROGRESS"].includes(t)).map((t) => (
                      <ApiForm key={t} action={`/api/cases/${id}/plan/${cur.id}/transition`} inline submitLabel={PLAN_STATUS_LABEL[t as PlanStatus]} extra={{ to: t }} testId={`plan-to-${t}`}
                        fields={t === "NEEDS_REVISION" || t === "CHANGE_REVIEW" ? [{ name: "note", label: "사유", type: "text", required: t === "NEEDS_REVISION" }] : []} />
                    ))}
                    {p.allowedTransitions.includes("APPROVED") && (p.canApprove ? (
                      <ApiForm action={`/api/cases/${id}/plan/${cur.id}/transition`} submitLabel="지원계획 승인" extra={{ to: "APPROVED" }} testId="plan-approve-form" fields={[{ name: "approvalBasis", label: "승인 근거 (회의 결정·검토 의견)", type: "textarea", required: true }]} />
                    ) : <div className="alert alert-info">승인 권한이 없습니다. 승인권자(지자체 정책)가 승인합니다.</div>)}
                    {canWrite && cur.status === "REVIEW_REQUESTED" && (
                      <details className="disclosure"><summary>통합지원회의 등록</summary><div>
                        <ApiForm action={`/api/cases/${id}/meetings`} submitLabel="회의 등록" extra={{ planId: cur.id }} testId="meeting-create-form" fields={[
                          { name: "scheduledAt", label: "회의 일시", type: "datetime", required: true },
                          { name: "agenda", label: "검토 안건", type: "textarea", required: true },
                          { name: "participants", label: "참석 조직 (줄마다 '조직 | 역할')", type: "pairs", required: true, defaultValue: "통합돌봄과 | 주관\n보건소 방문보건팀 | 보건\n" },
                        ]} />
                      </div></details>
                    )}
                  </div>
                </Panel>
              )}
              <Panel title="계획 버전 이력" id="versions">
                <ul style={{ margin: 0, paddingLeft: 16 }}>{p.plans.map((x: any) => <li key={x.id}>v{x.version_no} · {PLAN_STATUS_LABEL[x.status as PlanStatus]} · {fmtDate(x.updated_at)}</li>)}</ul>
              </Panel>
            </div>
          </div>
        );
      })()}

      {tab === "services" && (() => {
        const p = data.plans as Awaited<ReturnType<typeof getPlans>>;
        const s = data.services as Awaited<ReturnType<typeof listServiceReferralsForCase>>;
        const cur = p.current as any;
        const approved = cur && ["APPROVED", "REFERRING", "IN_PROGRESS"].includes(cur.status);
        return (
          <div className="stack">
            <Panel title="서비스 후보 확인 및 의뢰" id="match" note="후보는 규칙 기반 추천이며 담당자 검토용입니다. 수용 가능 여부는 최신 확인일 기준이며 오래된 정보는 '확인 필요'로 표시됩니다.">
              {!approved ? <div className="alert alert-info">승인된 개인별 지원계획이 있어야 서비스 의뢰를 할 수 있습니다. (현재: {cur ? PLAN_STATUS_LABEL[cur.status as PlanStatus] : "계획 없음"})</div> : (
                <div className="stack">
                  {p.items.map((i: any) => (
                    <div key={i.id} className="panel" style={{ padding: 12 }}>
                      <div className="row" style={{ justifyContent: "space-between" }}><h3>{SERVICE_TYPE_LABEL[i.service_type as ServiceType]} · {i.frequency}</h3>{i.referral_status ? <ServiceBadge s={i.referral_status} /> : <Badge tone="amber">미의뢰</Badge>}</div>
                      {canWrite && (!i.referral_status || ["UNAVAILABLE", "CANCELED", "REASSESSMENT_REQUIRED", "COMPLETED"].includes(i.referral_status)) && <div style={{ marginTop: 8 }}><MatchPanel caseId={id} planItemId={i.id} label={SERVICE_TYPE_LABEL[i.service_type as ServiceType]} /></div>}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title="서비스 의뢰·제공 현황" id="sr">
              {s.referrals.length === 0 ? <Empty>의뢰 내역 없음</Empty> : (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
                  <thead><tr><th scope="col">의뢰번호</th><th scope="col">서비스</th><th scope="col">제공기관</th><th scope="col">상태</th><th scope="col">시작 예정</th><th scope="col" className="wrap">기관 회신·사유</th><th scope="col">담당자 처리</th></tr></thead>
                  <tbody>{s.referrals.map((r: any) => {
                    const next = SERVICE_REFERRAL_TRANSITIONS[r.status as ServiceReferralStatus].filter((t) => SERVICE_TRANSITION_ACTOR[t] !== "provider");
                    return (
                      <tr key={r.id}>
                        <td>{r.referral_no}</td><td>{SERVICE_TYPE_LABEL[r.service_type as ServiceType]}</td><td>{r.provider_name}</td><td><ServiceBadge s={r.status} /></td>
                        <td>{fmtDate(r.scheduled_start)}</td><td className="wrap">{r.unavailable_reason ?? r.provider_note ?? "—"}</td>
                        <td className="wrap">{canWrite && next.map((t) => <ApiForm key={t} action={`/api/service-referrals/${r.id}/transition`} inline submitLabel={SERVICE_REFERRAL_STATUS_LABEL[t]} danger={t === "CANCELED"} extra={{ to: t, expectedVersion: r.version }} fields={t === "CANCELED" || t === "REASSESSMENT_REQUIRED" ? [{ name: "note", label: "사유", type: "text", required: true }] : []} />)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              )}
              {s.events.length > 0 && (
                <details className="disclosure" style={{ marginTop: 10 }}><summary>처리 이력 {s.events.length}건</summary><div>
                  <ol className="timeline">{s.events.map((e: any, i: number) => <li key={i}><time>{fmtDateTime(e.at)}</time>{e.from_status ? `${SERVICE_REFERRAL_STATUS_LABEL[e.from_status as ServiceReferralStatus]} → ` : ""}<strong>{SERVICE_REFERRAL_STATUS_LABEL[e.to_status as ServiceReferralStatus]}</strong> · {e.actor_kind === "provider" ? "제공기관" : "지자체"} {e.actor_name}{e.note ? ` — ${e.note}` : ""}</li>)}</ol>
                </div></details>
              )}
            </Panel>
          </div>
        );
      })()}

      {tab === "monitoring" && (
        <div className="split">
          <Panel title="모니터링 이력" id="mon">
            {(data.monitoring as any[]).length === 0 ? <Empty>모니터링 기록 없음</Empty> : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
                <thead><tr><th scope="col">확인 일시</th><th scope="col">방법</th><th scope="col">서비스 이용</th><th scope="col">만족도</th><th scope="col" className="wrap">상태 변화·미수행 사유</th><th scope="col">계획 변경</th><th scope="col">다음 예정</th><th scope="col">담당</th></tr></thead>
                <tbody>{(data.monitoring as any[]).map((m) => <tr key={m.id}><td>{fmtDateTime(m.checked_at)}</td><td>{MONITORING_METHOD_LABEL[m.method as MonitoringMethod]}</td><td>{({ yes: "이용", partial: "일부 이용", no: "미이용", unknown: "확인 불가" } as Record<string, string>)[m.service_used]}</td><td>{({ satisfied: "만족", neutral: "보통", dissatisfied: "불만족", no_response: "무응답" } as Record<string, string>)[m.satisfaction] ?? "—"}</td><td className="wrap">{[m.status_change, m.non_delivery_reason, m.additional_needs].filter(Boolean).join(" / ") || "—"}</td><td>{m.plan_change_needed ? <Badge tone="amber">필요</Badge> : "불필요"}</td><td>{fmtDate(m.next_due_at)}</td><td>{m.recorder_name}</td></tr>)}</tbody>
              </table></div>
            )}
          </Panel>
          {canWrite && (
            <Panel title="모니터링 기록" id="mon-form">
              <ApiForm action={`/api/cases/${id}/monitoring`} submitLabel="모니터링 저장" testId="monitoring-form" fields={[
                { name: "checkedAt", label: "확인 일시", type: "datetime", required: true, defaultValue: nowKstLocal() },
                { name: "method", label: "확인 방법", type: "select", required: true, options: [{ value: "visit", label: "방문" }, { value: "phone", label: "전화" }, { value: "other", label: "기타" }] },
                { name: "serviceUsed", label: "서비스 이용 여부", type: "select", required: true, options: [{ value: "yes", label: "이용" }, { value: "partial", label: "일부 이용" }, { value: "no", label: "미이용" }, { value: "unknown", label: "확인 불가" }] },
                { name: "satisfaction", label: "서비스 만족도", type: "select", emptyAs: "null", options: [{ value: "satisfied", label: "만족" }, { value: "neutral", label: "보통" }, { value: "dissatisfied", label: "불만족" }, { value: "no_response", label: "무응답" }] },
                { name: "statusChange", label: "대상자 상태 변화", type: "textarea" },
                { name: "nonDeliveryReason", label: "미수행 사유 (일부·미이용 시 필수)", type: "text" },
                { name: "additionalNeeds", label: "추가 욕구", type: "textarea" },
                { name: "planChangeNeeded", label: "지원계획 변경 필요", type: "checkbox" },
                { name: "nextDueAt", label: "다음 모니터링 예정일 (비우면 지자체 설정 주기)", type: "date" },
                { name: "opinion", label: "담당자 의견", type: "textarea" },
                { name: "followUps", label: "후속 업무 생성", type: "checks", options: [{ value: "visit_planned", label: "방문 예정" }, { value: "contact_needed", label: "연락 필요" }, { value: "service_not_delivered", label: "서비스 미수행" }, { value: "service_change", label: "서비스 변경 필요" }, { value: "provider_change", label: "기관 변경 필요" }, { value: "closure_review", label: "사례 종결 검토" }] },
              ]} />
            </Panel>
          )}
        </div>
      )}

      {tab === "records" && (
        <div className="split">
          <Panel title="상담 기록" id="records" note="수정 시 이전 내용이 이력으로 보존되며, 삭제는 사유와 함께 이력이 남는 논리 삭제입니다.">
            {(data.records as any[]).length === 0 ? <Empty>기록 없음</Empty> : (
              <ol className="timeline">{(data.records as any[]).map((r) => <li key={r.id}><time>{fmtDateTime(r.occurred_at)} · {RECORD_TYPE_LABEL[r.record_type as RecordType]} · {r.author_name}{r.revision > 1 ? ` · 수정 ${r.revision - 1}회` : ""}</time><div style={{ whiteSpace: "pre-wrap" }}>{r.body}</div></li>)}</ol>
            )}
          </Panel>
          {canWrite && (
            <Panel title="기록 작성" id="record-form">
              <ApiForm action={`/api/cases/${id}/records`} submitLabel="기록 저장" testId="record-form" fields={[
                { name: "recordType", label: "기록 유형", type: "select", required: true, options: RECORD_TYPES.map((t) => ({ value: t, label: RECORD_TYPE_LABEL[t] })) },
                { name: "occurredAt", label: "일시", type: "datetime", required: true, defaultValue: nowKstLocal() },
                { name: "body", label: "내용", type: "textarea", required: true, maxLength: 4000 },
              ]} />
            </Panel>
          )}
        </div>
      )}

      {tab === "timeline" && (
        <Panel title="업무 타임라인" id="tl">
          {(data.timeline as any[]).length === 0 ? <Empty /> : (
            <ol className="timeline">{(data.timeline as any[]).map((t, i) => <li key={i}><time>{fmtDateTime(t.at)}</time><strong>{TIMELINE_KIND[t.kind] ?? t.kind}</strong> · {t.kind === "status" ? `${CASE_STATUS_LABEL[t.detail as CaseStatus] ?? t.detail ?? ""} → ${CASE_STATUS_LABEL[t.title as CaseStatus] ?? t.title}` : t.kind === "service" ? `${t.detail} ${SERVICE_REFERRAL_STATUS_LABEL[t.title as ServiceReferralStatus] ?? t.title}` : t.kind === "plan" ? `${t.detail} ${PLAN_STATUS_LABEL[t.title as PlanStatus] ?? t.title}` : t.kind === "record" ? RECORD_TYPE_LABEL[t.title as RecordType] ?? t.title : t.kind === "monitoring" ? `${MONITORING_METHOD_LABEL[t.title as MonitoringMethod] ?? t.title}${t.detail ? ` · ${t.detail}` : ""}` : t.title}</li>)}</ol>
          )}
        </Panel>
      )}

      {tab === "ai" && (
        <Panel title="AI 행정 업무 보조" id="ai-panel">
          <AiDraftPanel target={{ caseId: id }} kinds={["social_opinion", "meeting_brief"]} groups={data.groups as any} canWrite={canWrite} aiEnabled={Boolean(data.aiEnabled)} />
        </Panel>
      )}
    </>
  );
}
