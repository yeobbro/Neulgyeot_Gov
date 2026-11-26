import Link from "next/link";
import { Badge, Empty } from "@/components/ui";
import { ControlMap } from "@/components/client/ControlMap";
import { AlertActions, AutoRefresh, DispatchActions } from "@/components/client/ControlActions";
import {
  ALERT_STATUS_LABEL, DISPATCH_STATUS_LABEL, PROVISIONAL_VITAL_THRESHOLDS, SUBJECT_STATUSES, SUBJECT_STATUS_CHIP, SUBJECT_STATUS_COLOR, SUBJECT_STATUS_LABEL,
  type AlertStatus, type DispatchStatus, type SubjectStatus,
} from "@/lib/domain/control";
import { isAdmin } from "@/lib/server/authz";
import { withPage } from "@/lib/server/page";
import { controlOverview, dispatchCandidates, type Subject } from "@/lib/server/services/control";
import { refreshWearableGaps } from "@/lib/server/services/wearables";

export const metadata = { title: "통합 관제" };

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
};
const PRIORITY: Record<SubjectStatus, number> = { urgent: 0, caution: 1, in_service: 2, normal: 3, unlinked: 4 };

function Donut({ counts, total }: { counts: Record<SubjectStatus, number>; total: number }) {
  const R = 54;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <svg viewBox="0 0 140 140" className="ctl-donut" role="img" aria-label={`전체 ${total}명 상태 분포`}>
      <circle cx="70" cy="70" r={R} fill="none" stroke="var(--gray-soft)" strokeWidth="16" />
      {total > 0 && SUBJECT_STATUSES.map((s) => {
        const len = (counts[s] / total) * C;
        const el = <circle key={s} cx="70" cy="70" r={R} fill="none" stroke={SUBJECT_STATUS_COLOR[s]} strokeWidth="16" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)" />;
        acc += len;
        return el;
      })}
      <text x="70" y="68" textAnchor="middle" className="ctl-donut-n">{total}명</text>
      <text x="70" y="86" textAnchor="middle" className="ctl-donut-l">전체 대상자</text>
    </svg>
  );
}

function Vitals({ s }: { s: Subject }) {
  const r = s.reading;
  if (!r) return <span className="muted">{s.device ? "수신 없음" : "미연결"}</span>;
  return (
    <span className={`ctl-vitals-inline ${r.fresh ? "" : "stale"}`} title={r.fresh ? "최근 측정값" : "갱신 지연된 측정값"}>
      <span className="hr">♥ {r.heartRate ?? "—"}</span>
      <span className="tp">{r.bodyTempC != null ? `${r.bodyTempC.toFixed(1)}℃` : "—"}</span>
    </span>
  );
}

export default async function ControlPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;
  const { o, candidates, admin, me } = await withPage(async (tx, actor) => {
    await refreshWearableGaps(tx, actor.tenantId);
    return { o: await controlOverview(tx, actor), candidates: await dispatchCandidates(tx), admin: isAdmin(actor), me: actor.id };
  }, { roles: ["municipal_admin", "case_manager"] });

  const k = o.kpis;
  const pct = (n: number) => (k.total ? `${((n / k.total) * 100).toFixed(1)}%` : "0%");
  const watch = [...o.subjects].filter((s) => s.status !== "unlinked").sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]).slice(0, 6);
  const myDispatches = o.dispatches.filter((d) => d.assigneeId === me && ["requested", "accepted", "on_site"].includes(d.status));

  return (
    <div className="ctl">
      <div className="ctl-head">
        <div>
          <h1>통합 관제</h1>
          <p className="muted">돌봄 대상자 위치·상태 통합 현황 · {admin ? "지자체 전체" : "담당 권역"} · 기준 {new Date(o.asOf).toLocaleString("ko-KR")}</p>
        </div>
        <AutoRefresh seconds={60} />
      </div>

      <div className="alert alert-warn ctl-notice" role="note">
        <strong>의료 판단·응급 관제 아님.</strong> 측정값 분류는 <strong>의료진 검토 전 임시 기준</strong>
        (심박 {PROVISIONAL_VITAL_THRESHOLDS.heartRate.urgentHigh}↑ / 체온 {PROVISIONAL_VITAL_THRESHOLDS.bodyTempC.urgentHigh}℃↑ / SpO₂ {PROVISIONAL_VITAL_THRESHOLDS.spo2.urgentBelow}% 미만 → 긴급)이며
        담당자 확인용입니다. 생명이 위급하면 119·응급안전안심서비스 체계를 따르세요. 인물·위치·수치는 모두 합성 데이터입니다.
      </div>

      <section className="ctl-kpis" aria-label="관제 지표">
        <div className="ctl-kpi"><span className="ic i-blue">👥</span><div><div className="l">전체 돌봄대상자</div><div className="v">{k.total}<small>명</small></div></div></div>
        <div className="ctl-kpi"><span className="ic i-green">📡</span><div><div className="l">실시간 모니터링</div><div className="v">{k.monitored}<small>명 ({pct(k.monitored)})</small></div></div></div>
        <div className="ctl-kpi"><span className="ic i-amber">⚠</span><div><div className="l">이상 징후(주의)</div><div className="v amber">{k.caution}<small>명</small></div></div></div>
        <div className="ctl-kpi"><span className="ic i-red">🚨</span><div><div className="l">긴급 대응 필요</div><div className="v red">{k.urgent}<small>명</small></div></div></div>
        <div className="ctl-kpi"><span className="ic i-teal">🤝</span><div><div className="l">서비스 진행중</div><div className="v">{k.servicesActive}<small>건</small></div></div></div>
        <div className="ctl-kpi"><span className="ic i-blue">🚐</span><div><div className="l">오늘 현장 방문</div><div className="v">{k.visitsToday}<small>건</small></div></div></div>
      </section>

      <div className="ctl-main">
        <section className="panel ctl-map-wrap" aria-label="대상자 지도">
          <ControlMap subjects={o.subjects} candidates={candidates} canDispatch focus={focus} />
        </section>

        <div className="ctl-side">
          <section className="panel ctl-card" aria-labelledby="st-h">
            <h2 id="st-h">대상자 상태 현황</h2>
            <div className="ctl-donut-row">
              <Donut counts={o.statusCounts} total={k.total} />
              <ul className="ctl-legend">
                {SUBJECT_STATUSES.map((s) => (
                  <li key={s}><span className="dot" style={{ background: SUBJECT_STATUS_COLOR[s] }} />{SUBJECT_STATUS_LABEL[s]}<strong>{o.statusCounts[s]}명</strong><small>({pct(o.statusCounts[s])})</small></li>
                ))}
              </ul>
            </div>
          </section>

          <section className="panel ctl-card" aria-labelledby="watch-h">
            <div className="ctl-card-head"><h2 id="watch-h">주요 대상자 실시간 모니터링</h2><Link href="/cases">전체보기 ›</Link></div>
            {watch.length === 0 ? <Empty>모니터링 대상 없음</Empty> : (
              <div className="ctl-scroll" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="ctl-table">
                <thead><tr><th scope="col">대상자</th><th scope="col">상태</th><th scope="col">측정값</th><th scope="col">위치/서비스</th></tr></thead>
                <tbody>
                  {watch.map((s) => (
                    <tr key={s.caseId}>
                      <td><Link href={`/control?focus=${s.caseId}`}>{s.name}</Link> <small className="muted">({s.ageBand ?? "—"})</small></td>
                      <td><span className="ctl-chip" style={{ background: SUBJECT_STATUS_CHIP[s.status] }}>{SUBJECT_STATUS_LABEL[s.status]}</span></td>
                      <td><Vitals s={s} /></td>
                      <td><small>{s.region}<br /><span className="muted">{s.visitInProgress ? "방문 서비스 중" : s.location.mode === "current" ? "실시간 위치" : "지정 위치"}</span></small></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>
        </div>
      </div>

      <div className="ctl-bottom">
        <section className="panel ctl-card" aria-labelledby="feed-h">
          <div className="ctl-card-head"><h2 id="feed-h">실시간 이슈 알림 ({o.feed.length}건)</h2><Link href="/tasks">후속 업무 ›</Link></div>
          {o.feed.length === 0 ? <Empty>확인할 알림이 없습니다.</Empty> : (
            <ul className="ctl-feed" data-testid="control-feed">
              {o.feed.slice(0, 8).map((f) => (
                <li key={f.id}>
                  <span className={`ctl-sev ${f.severity}`}>{f.severity === "urgent" ? "긴급" : "주의"}</span>
                  <Link href={`/control?focus=${f.caseId}`} className="who">{f.name} <small>({f.ageBand ?? "—"})</small></Link>
                  <span className="msg">{f.message}</span>
                  <small className="muted when">{ago(f.at)}</small>
                  {f.source === "alert" ? (
                    <span className="act"><Badge tone={f.status === "in_progress" ? "blue" : "amber"}>{ALERT_STATUS_LABEL[f.status as AlertStatus]}</Badge><AlertActions id={f.id} status={f.status} /></span>
                  ) : (
                    <span className="act"><Link className="btn btn-sm" href={`/cases/${f.caseId}?tab=wearable`}>일 요약 신호 확인</Link></span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel ctl-card" aria-labelledby="svc-h">
          <div className="ctl-card-head"><h2 id="svc-h">오늘의 서비스 운영 현황</h2><Link href="/service-referrals">전체보기 ›</Link></div>
          <div className="ctl-svc">
            {o.serviceGroups.map((g) => (
              <div key={g.key} className="ctl-svc-item">
                <div className="l">{g.label}</div>
                <div className="v">{g.total}<small>건</small></div>
                <small className="muted">진행 {g.inProgress} · 완료 {g.completed}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel ctl-card" aria-labelledby="morning-h" style={{ marginTop: 16 }}>
        <div className="ctl-card-head">
          <h2 id="morning-h">아침 안부 요약 · 링 착용자 ({o.morning.length}명)</h2>
          <span className="muted">하루 단위로 동기화되는 기기(예: 시그링)의 어제 요약을 본인 평소(최근 14일 중앙값)와 비교합니다. 진단이 아닙니다.</span>
        </div>
        {o.morning.length === 0 ? <Empty>일 요약 기기 착용자가 없습니다.</Empty> : (
          <div className="ctl-scroll" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="ctl-table" data-testid="morning-summary">
            <thead><tr><th scope="col">대상자</th><th scope="col">기기</th><th scope="col">요약일</th><th scope="col">활력 지수 (평소)</th><th scope="col">수면 (평소)</th><th scope="col">걸음 (평소)</th><th scope="col">피부 온도</th><th scope="col">확인</th></tr></thead>
            <tbody>
              {o.morning.map((m) => {
                const low = m.vitality != null && m.vitalityUsual != null && m.vitalityUsual - m.vitality >= 10;
                const hm = (x: number | null) => (x == null ? "—" : `${Math.floor(x / 60)}h ${String(x % 60).padStart(2, "0")}m`);
                return (
                  <tr key={m.caseId}>
                    <td><Link href={`/cases/${m.caseId}?tab=wearable`}>{m.name}</Link> <small className="muted">({m.ageBand ?? "—"}) · {m.region}</small></td>
                    <td><small>{m.profileLabel}</small></td>
                    <td>{m.date ?? "—"}</td>
                    <td className={low ? "red" : ""}>{m.vitality ?? "—"} <small className="muted">({m.vitalityUsual ?? "—"})</small></td>
                    <td>{hm(m.sleepMinutes)} <small className="muted">({hm(m.sleepUsual)})</small></td>
                    <td>{m.steps?.toLocaleString("ko-KR") ?? "—"} <small className="muted">({m.stepsUsual?.toLocaleString("ko-KR") ?? "—"})</small></td>
                    <td className={m.skinTempDeviationC != null && m.skinTempDeviationC >= 1 ? "amber" : ""}>{m.skinTempDeviationC != null ? `${m.skinTempDeviationC > 0 ? "+" : ""}${m.skinTempDeviationC.toFixed(1)}℃` : "—"}</td>
                    <td>{m.openSignals > 0 ? <span className="ctl-chip" style={{ background: SUBJECT_STATUS_CHIP.caution }}>신호 {m.openSignals}건</span> : <span className="muted">평소와 비슷</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="panel ctl-card" aria-labelledby="staff-h" style={{ marginTop: 16 }}>
        <div className="ctl-card-head"><h2 id="staff-h">현장 인력 관리</h2><span className="muted">출동 요청은 담당 권역 사례관리자에게만 보낼 수 있습니다.</span></div>
        {myDispatches.length > 0 && (
          <div className="ctl-mine">
            <strong>나에게 온 출동요청</strong>
            {myDispatches.map((d) => (
              <span key={d.id} className="ctl-mine-item">{d.caseCode} {d.name} · {DISPATCH_STATUS_LABEL[d.status as DispatchStatus]} · {ago(d.at)} <DispatchActions id={d.id} status={d.status} /></span>
            ))}
          </div>
        )}
        <div className="ctl-staff">
          <div className="ctl-scroll" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="ctl-table">
            <thead><tr><th scope="col">담당자</th><th scope="col">담당 대상자</th><th scope="col">긴급/주의</th><th scope="col">진행 중 출동</th><th scope="col">오늘 완료</th></tr></thead>
            <tbody>
              {o.staff.map((u) => (
                <tr key={u.id}><td>{u.name}</td><td>{u.subjects}명</td><td><span className="red">{u.urgent}</span> / <span className="amber">{u.caution}</span></td><td>{u.activeDispatches}건</td><td>{u.completedToday}건</td></tr>
              ))}
            </tbody>
          </table></div>
          <div className="ctl-scroll" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="ctl-table">
            <thead><tr><th scope="col">제공기관 (오늘 방문)</th><th scope="col">예정</th><th scope="col">방문 중</th><th scope="col">완료</th><th scope="col">미방문</th></tr></thead>
            <tbody>
              {o.providerVisits.length === 0 ? <tr><td colSpan={5} className="muted">오늘 방문 일정 없음</td></tr> : o.providerVisits.map((p) => (
                <tr key={p.provider}><td>{p.provider}</td><td>{p.scheduled}</td><td>{p.inProgress}</td><td>{p.completed}</td><td>{p.missed}</td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
        {o.dispatches.length > 0 && (
          <p className="muted" style={{ marginTop: 8 }}>오늘 출동: {o.dispatches.map((d) => `${d.caseCode} ${d.assigneeName} (${DISPATCH_STATUS_LABEL[d.status as DispatchStatus]})`).join(" · ")}</p>
        )}
      </section>
    </div>
  );
}
