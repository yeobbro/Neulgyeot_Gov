"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fmtDateTime } from "@/lib/format";
import { api, errorText } from "./api";

type Fact = { id: string; text: string; sourceType: string; sourceId: string; field: string };
type Content = {
  sections: { title: string; sentences: { text: string; factIds: string[] }[] }[]; facts: Fact[]; text: string;
  ai?: { sectionEngines?: string[]; model?: string | null; promptVersion?: string | null };
};
type Draft = {
  id: string; kind: string; engine: string; status: string; selection_status: string; created_at: string; selected_at: string | null; reviewed_at: string | null;
  creator: string; reviewer: string | null; selector: string | null; edited_text: string | null; content: Content; isRoot: boolean; source: "rule_based" | "ai";
};
type Sent = { text: string; factIds: string[]; mark: "same" | "ai_only" | "rule_only"; newEvidence: string[] };
type Job = {
  id: string; status: "pending" | "processing" | "completed" | "failed" | "cancelled"; engine: string | null; attempts: number; maxAttempts: number;
  retryable: boolean; canRequestAgain: boolean; error: { code: string; message: string | null } | null; requestedAt: string; nextAttemptAt: string | null;
  modelVersion: string | null; promptVersion: string | null;
};
export type DraftGroup = {
  groupId: string; kind: string; drafts: Draft[]; selectedDraftId: string | null; approvedDraftId: string | null; job: Job | null;
  comparison: { ruleDraftId: string; aiDraftId: string; result: { sections: { title: string; rule: Sent[]; ai: Sent[]; aiEngine: string | null }[]; summary: { same: number; aiOnly: number; ruleOnly: number } } } | null;
};

const KIND_LABEL: Record<string, string> = { referral_summary: "연계 신청 요약", social_opinion: "사회복지 종합 소견서 초안", meeting_brief: "회의 자료·사례 요약" };
const STATUS_LABEL: Record<string, string> = { draft: "검토 전 초안", approved: "담당자 승인", discarded: "폐기" };
const JOB_LABEL: Record<Job["status"], [string, string]> = {
  pending: ["AI 초안 대기 중", "b-amber"], processing: ["AI 초안 생성 중", "b-blue"], completed: ["AI 초안 생성 완료", "b-green"],
  failed: ["AI 초안 생성 실패", "b-red"], cancelled: ["AI 요청 취소됨", "b-gray"],
};
const ENGINE_LABEL: Record<string, string> = { rules: "규칙 기반", llm: "규칙 기반", "ai-intelligence": "AI 생성", hybrid: "AI + 규칙 혼합" };
const MARK_LABEL: Record<Sent["mark"], [string, string]> = { same: ["동일", "b-gray"], ai_only: ["AI에만 있음", "b-amber"], rule_only: ["규칙에만 있음", "b-amber"] };

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) => {
    setBusy(true);
    setErr(null);
    const r = await api(url, { body: opts.body ?? {}, headers: opts.headers });
    setBusy(false);
    if (!r.ok) setErr(errorText(r.error));
    else router.refresh();
    return r.ok;
  };
  return { busy, err, run, router };
}

export function AiDraftPanel({ target, kinds, groups, canWrite, aiEnabled }: { target: { caseId?: string; referralId?: string }; kinds: string[]; groups: DraftGroup[]; canWrite: boolean; aiEnabled: boolean }) {
  const { busy, err, run } = useAction();
  return (
    <div className="stack">
      <div className="alert alert-info">
        규칙 기반 초안은 서버 안에서만 만들어지며 외부로 전송되지 않습니다.{" "}
        {aiEnabled
          ? "이 기관은 AI 제안 요청이 켜져 있습니다. AI에는 허용된 구조화 사실만 전송되며(자유 서술·소견 원문 제외), 합성 데이터가 아니면 전송하지 않습니다. "
          : "이 기관은 AI 제안 요청이 꺼져 있습니다(기본값). "}
        모든 결과는 <strong>검토 전 초안</strong>입니다. 담당자가 비교·선택하고 승인해야 공식 기록이 됩니다. 복지 자격·긴급성·진단을 판단하지 않습니다.
      </div>
      {canWrite && (
        <div className="row">
          {kinds.map((k) => (
            <button key={k} type="button" className="btn btn-sm" disabled={busy} data-testid={`ai-${k}`} onClick={() => run("/api/ai/drafts", { body: { kind: k, ...target } })}>
              {KIND_LABEL[k]} 생성
            </button>
          ))}
        </div>
      )}
      <div role="alert">{err && <div className="alert alert-error">{err}</div>}</div>
      {groups.length === 0 && <p className="panel-note">생성된 초안이 없습니다.</p>}
      {groups.map((g) => <DraftGroupView key={g.groupId} g={g} target={target} canWrite={canWrite} aiEnabled={aiEnabled} />)}
    </div>
  );
}

function DraftGroupView({ g, target, canWrite, aiEnabled }: { g: DraftGroup; target: { caseId?: string }; canWrite: boolean; aiEnabled: boolean }) {
  const { busy, err, run, router } = useAction();
  const root = g.drafts.find((d) => d.isRoot) ?? g.drafts[0];
  const ai = g.comparison ? g.drafts.find((d) => d.id === g.comparison!.aiDraftId) : undefined;
  const live = g.drafts.filter((d) => d.status === "draft");
  const approved = g.drafts.find((d) => d.id === g.approvedDraftId);
  const selected = g.drafts.find((d) => d.id === g.selectedDraftId);
  const discarded = g.drafts.filter((d) => d.status === "discarded" && d.id !== ai?.id && d.id !== root.id);
  const active = g.job && (g.job.status === "pending" || g.job.status === "processing");
  // while a job is queued or running, refresh every 15 s (server state; nothing is decided on the client)
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [active, router]);
  const canRequestAi = aiEnabled && canWrite && root.status === "draft" && !approved && !active && !(ai && ai.status === "draft");
  const toApprove = approved ? null : selected ?? (live.length === 1 ? live[0] : null);
  const groupBadge = approved ? ["승인 완료", "b-green"] : selected ? ["검토할 초안 선택됨", "b-blue"] : live.length > 1 ? ["비교 필요", "b-amber"] : live.length ? ["검토 전", "b-amber"] : ["처리 완료", "b-gray"];

  return (
    <article className="ai-box" aria-label={`${KIND_LABEL[g.kind]} 초안 그룹`} data-testid={`ai-group-${g.groupId}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="ai-label">AI 보조 초안 · {KIND_LABEL[g.kind]} · {fmtDateTime(root.created_at)}</span>
        <span className={`badge ${groupBadge[1]}`}>{groupBadge[0]}</span>
      </div>

      {(g.job || canRequestAi) && (
        <div className="row" style={{ marginTop: 8 }} data-testid={`ai-job-${g.groupId}`}>
          {g.job && (
            <>
              <span className={`badge ${JOB_LABEL[g.job.status][1]}`}>{JOB_LABEL[g.job.status][0]}</span>
              <span className="panel-note">
                요청 {fmtDateTime(g.job.requestedAt)} · 시도 {g.job.attempts}/{g.job.maxAttempts}
                {g.job.engine ? ` · 생성 방식 ${ENGINE_LABEL[g.job.engine] ?? g.job.engine}` : ""}
                {g.job.retryable && g.job.nextAttemptAt ? ` · 자동 재시도 예정 ${fmtDateTime(g.job.nextAttemptAt)}` : ""}
              </span>
              {g.job.error && <span className="panel-note" role="status">오류: {g.job.error.message} (규칙 기반 초안은 그대로 사용할 수 있습니다)</span>}
              {g.job.status === "pending" && <span className="panel-note">AI 처리 서버가 연결되지 않은 환경에서는 처리되지 않습니다.</span>}
              {active && canWrite && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(`/api/ai/jobs/${g.job!.id}/cancel`)}>요청 취소</button>}
              {active && <button type="button" className="btn btn-sm" onClick={() => router.refresh()}>상태 새로고침</button>}
            </>
          )}
          {canRequestAi && (
            <button type="button" className="btn btn-sm" disabled={busy} data-testid={`ai-request-${root.id}`}
              onClick={() => run(`/api/ai/drafts/${root.id}/ai-jobs`, { headers: { "idempotency-key": `ui-${root.id}-${g.job?.id ?? "first"}` } })}>
              {g.job ? "AI 초안 다시 요청" : "AI 초안 요청"}
            </button>
          )}
        </div>
      )}
      <div role="alert">{err && <div className="alert alert-error" style={{ marginTop: 8 }}>{err}</div>}</div>

      {g.comparison && ai ? (
        <CompareView g={g} rule={root} ai={ai} canSelect={canWrite && !approved} busy={busy} run={run} />
      ) : (
        <DraftBody d={root} />
      )}

      {toApprove && canWrite && <ApproveBox d={toApprove} target={target} competing={live.length > 1} />}
      {approved && (
        <p className="panel-note" style={{ marginTop: 6 }}>
          승인: {approved.reviewer ?? "—"} · {fmtDateTime(approved.reviewed_at)} · {approved.source === "ai" ? "AI 초안" : "규칙 기반 초안"}
        </p>
      )}
      {!approved && root.status === "discarded" && !ai && <p className="panel-note" style={{ marginTop: 6 }}>처리자: {root.reviewer ?? "—"}</p>}
      {discarded.length > 0 && <p className="panel-note">이전에 폐기된 AI 초안 {discarded.length}건</p>}
    </article>
  );
}

function Evidence({ facts, ids, collectedAt }: { facts: Fact[]; ids: string[]; collectedAt: string }) {
  return (
    <div className="evidence">
      {ids.map((id) => {
        const f = facts.find((x) => x.id === id);
        return (
          <div key={id}>
            <strong>{id}</strong> {f ? f.text : "근거를 찾을 수 없음"}
            {f && <> · 출처 <code>{f.sourceType}:{f.sourceId.slice(0, 14)}·{f.field}</code></>} · 수집 {fmtDateTime(collectedAt)}
          </div>
        );
      })}
    </div>
  );
}

function SentenceItem({ s, d, mark }: { s: { text: string; factIds: string[] }; d: Draft; mark?: Sent }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`cmp-sent ${mark?.mark ?? ""}`}>
      {s.text}
      {mark && mark.mark !== "same" && <span className={`badge ${MARK_LABEL[mark.mark][1]}`} style={{ marginLeft: 6 }}>{MARK_LABEL[mark.mark][0]}</span>}
      {s.factIds.length > 0 && (
        <button type="button" className="source-btn" aria-expanded={open} onClick={() => setOpen(!open)} title="문장 근거 보기">
          근거 {s.factIds.join(", ")}
        </button>
      )}
      {open && <Evidence facts={d.content.facts} ids={s.factIds} collectedAt={d.created_at} />}
    </li>
  );
}

function DraftBody({ d }: { d: Draft }) {
  return (
    <div style={{ marginTop: 8 }}>
      {d.content.sections.map((s, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <h3>{i + 1}. {s.title}</h3>
          {s.sentences.length === 0 ? <p className="panel-note">근거 자료 없음 — 확인 필요</p> : (
            <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{s.sentences.map((x, j) => <SentenceItem key={j} s={x} d={d} />)}</ul>
          )}
        </div>
      ))}
      <details className="disclosure">
        <summary>원본 근거 (사실 {d.content.facts.length}건)</summary>
        <div>
          <table className="data"><thead><tr><th scope="col">ID</th><th scope="col" className="wrap">원본 사실</th><th scope="col">출처</th></tr></thead>
            <tbody>{d.content.facts.map((f) => <tr key={f.id}><td>{f.id}</td><td className="wrap">{f.text}</td><td><code>{f.sourceType}:{f.sourceId.slice(0, 14)}·{f.field}</code></td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function CompareView({ g, rule, ai, canSelect, busy, run }: { g: DraftGroup; rule: Draft; ai: Draft; canSelect: boolean; busy: boolean; run: (u: string, o?: { body?: unknown }) => Promise<boolean> }) {
  const cmp = g.comparison!.result;
  const col = (d: Draft, side: "rule" | "ai") => (
    <section className={`cmp-col ${d.selection_status === "selected" ? "is-selected" : ""} ${d.status === "discarded" ? "is-discarded" : ""}`} aria-label={side === "rule" ? "규칙 기반 초안" : "AI 생성 초안"} data-testid={`ai-col-${side}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{side === "rule" ? "규칙 기반 초안" : "AI 생성 초안"}</strong>
        <span className={`badge ${d.status === "approved" ? "b-green" : d.status === "discarded" ? "b-gray" : d.selection_status === "selected" ? "b-blue" : "b-amber"}`}>
          {d.status !== "draft" ? STATUS_LABEL[d.status] : d.selection_status === "selected" ? "선택됨" : d.selection_status === "set_aside" ? "보관" : "후보"}
        </span>
      </div>
      <p className="panel-note">
        {ENGINE_LABEL[d.engine] ?? d.engine} · 생성 {fmtDateTime(d.created_at)}
        {side === "ai" && d.content.ai?.model ? ` · 모델 ${d.content.ai.model}` : ""}
        {side === "ai" && d.content.ai?.promptVersion ? ` · 프롬프트 ${d.content.ai.promptVersion}` : ""}
      </p>
      {cmp.sections.map((s, i) => {
        const sents = side === "rule" ? s.rule : s.ai;
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <h3>{i + 1}. {s.title}{side === "ai" && s.aiEngine === "rules" && <span className="badge b-gray" style={{ marginLeft: 6 }}>규칙 문장 유지</span>}</h3>
            {sents.length === 0 ? <p className="panel-note">문장 없음</p> : <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{sents.map((x, j) => <SentenceItem key={j} s={x} d={d} mark={x} />)}</ul>}
          </div>
        );
      })}
    </section>
  );
  return (
    <div className="stack" style={{ marginTop: 10, gap: 10 }}>
      <p className="panel-note" data-testid="ai-compare-summary">
        비교 결과: 동일 {cmp.summary.same}문장 · AI에만 있음 {cmp.summary.aiOnly}문장 · 규칙에만 있음 {cmp.summary.ruleOnly}문장.
        AI 문장의 근거는 서버에서 요청에 포함된 사실인지 확인된 것만 저장됩니다. 의미가 근거와 맞는지는 담당자가 확인해야 합니다.
      </p>
      <div className="grid-2">{col(rule, "rule")}{col(ai, "ai")}</div>
      {canSelect && (
        <div className="row" role="group" aria-label="검토할 초안 선택">
          {rule.status === "draft" && <button type="button" className="btn btn-sm" disabled={busy || rule.selection_status === "selected"} data-testid="ai-select-rule" onClick={() => run(`/api/ai/drafts/${rule.id}/select`, { body: { action: "select" } })}>규칙 기반 초안 선택</button>}
          {ai.status === "draft" && <button type="button" className="btn btn-sm" disabled={busy || ai.selection_status === "selected"} data-testid="ai-select-ai" onClick={() => run(`/api/ai/drafts/${ai.id}/select`, { body: { action: "select" } })}>AI 초안 선택</button>}
          {ai.status === "draft" && <button type="button" className="btn btn-sm btn-danger" disabled={busy} data-testid="ai-discard-ai" onClick={() => run(`/api/ai/drafts/${ai.id}/review`, { body: { action: "discard" } })}>AI 초안 폐기</button>}
          <button type="button" className="btn btn-sm" disabled={busy} data-testid="ai-hold" onClick={() => run(`/api/ai/drafts/${rule.id}/select`, { body: { action: "hold" } })}>보류 (나중에 비교)</button>
          <span className="panel-note">선택은 승인이 아닙니다. 선택한 초안만 아래에서 최종 확인 후 승인할 수 있습니다.</span>
        </div>
      )}
    </div>
  );
}

function ApproveBox({ d, target, competing }: { d: Draft; target: { caseId?: string }; competing: boolean }) {
  const { busy, err, run } = useAction();
  const [text, setText] = useState(d.content.text);
  const [checked, setChecked] = useState(false);
  return (
    <div className="stack" style={{ marginTop: 10, gap: 8 }}>
      <div className="field">
        <label htmlFor={`edit-${d.id}`}>
          담당자 검토·수정본 — {d.source === "ai" ? "AI 초안" : "규칙 기반 초안"}{competing ? " (선택됨)" : ""} (승인 시 이 내용이 확정됩니다)
        </label>
        <textarea id={`edit-${d.id}`} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <label className="row" style={{ fontSize: 13 }}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid={`ai-confirm-${d.id}`} />
        각 문장의 근거와 내용을 확인했으며, 이 초안을 승인합니다.
      </label>
      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !checked} data-testid={`ai-approve-${d.id}`}
          onClick={() => run(`/api/ai/drafts/${d.id}/review`, { body: { action: "approve", editedText: text, saveAsRecord: Boolean(target.caseId) } })}>
          검토 완료·승인{target.caseId ? " (사례 기록으로 저장)" : ""}
        </button>
        {!competing && (
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(`/api/ai/drafts/${d.id}/review`, { body: { action: "discard" } })}>폐기</button>
        )}
      </div>
      <div role="alert">{err && <div className="alert alert-error">{err}</div>}</div>
    </div>
  );
}
