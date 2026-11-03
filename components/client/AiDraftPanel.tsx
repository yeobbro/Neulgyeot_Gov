"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "./api";

type Fact = { id: string; text: string; sourceType: string; sourceId: string; field: string };
type Draft = {
  id: string; kind: string; engine: string; status: string; created_at: string; creator: string; reviewer: string | null; edited_text: string | null;
  content: { sections: { title: string; sentences: { text: string; factIds: string[] }[] }[]; facts: Fact[]; text: string };
};
const KIND_LABEL: Record<string, string> = { referral_summary: "연계 신청 요약", social_opinion: "사회복지 종합 소견서 초안", meeting_brief: "회의 자료·사례 요약" };
const STATUS_LABEL: Record<string, string> = { draft: "검토 전 초안", approved: "담당자 승인", discarded: "폐기" };

export function AiDraftPanel({ target, kinds, drafts, canWrite, llm }: { target: { caseId?: string; referralId?: string }; kinds: string[]; drafts: Draft[]; canWrite: boolean; llm: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  return (
    <div className="stack">
      <div className="alert alert-info">
        {llm ? "외부 LLM 사용이 설정되어 있습니다. 비식별 사실 문장만 전송되며, " : "규칙 기반 초안(외부 전송 없음)입니다. "}
        모든 결과는 <strong>검토 전 초안</strong>으로 저장되며, 담당자가 확인·수정·승인해야 공식 기록이 됩니다. 복지 자격·긴급성·진단을 판단하지 않습니다.
      </div>
      {canWrite && (
        <div className="row">
          {kinds.map((k) => (
            <button key={k} type="button" className="btn btn-sm" disabled={busy} data-testid={`ai-${k}`}
              onClick={async () => { setBusy(true); setErr(null); const r = await api("/api/ai/drafts", { body: { kind: k, ...target } }); setBusy(false); if (!r.ok) setErr(errorText(r.error)); else router.refresh(); }}>
              {KIND_LABEL[k]} 생성
            </button>
          ))}
        </div>
      )}
      <div role="alert">{err && <div className="alert alert-error">{err}</div>}</div>
      {drafts.length === 0 && <p className="panel-note">생성된 초안이 없습니다.</p>}
      {drafts.map((d) => (
        <article key={d.id} className="ai-box" aria-label={KIND_LABEL[d.kind]}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="ai-label">AI 보조 초안 · {KIND_LABEL[d.kind]} · {d.engine === "llm" ? "LLM" : "규칙 기반"}</span>
            <span className={`badge ${d.status === "draft" ? "b-amber" : d.status === "approved" ? "b-green" : "b-gray"}`}>{STATUS_LABEL[d.status]}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            {d.content.sections.map((s, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <h3>{i + 1}. {s.title}</h3>
                {s.sentences.length === 0 ? <p className="panel-note">근거 자료 없음 — 확인 필요</p> : (
                  <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                    {s.sentences.map((x, j) => (
                      <li key={j}>{x.text}{x.factIds.map((f) => <span key={f} className="source-ref" title={d.content.facts.find((ff) => ff.id === f)?.text}>{f}</span>)}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <details className="disclosure">
            <summary>원본 근거 (사실 {d.content.facts.length}건)</summary>
            <div>
              <table className="data"><thead><tr><th scope="col">ID</th><th scope="col" className="wrap">원본 사실</th><th scope="col">출처</th></tr></thead>
                <tbody>{d.content.facts.map((f) => <tr key={f.id}><td>{f.id}</td><td className="wrap">{f.text}</td><td><code>{f.sourceType}:{f.sourceId.slice(0, 14)}·{f.field}</code></td></tr>)}</tbody>
              </table>
            </div>
          </details>
          {d.status === "draft" && canWrite && (
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="field">
                <label htmlFor={`edit-${d.id}`}>담당자 검토·수정본 (승인 시 이 내용이 확정됩니다)</label>
                <textarea id={`edit-${d.id}`} rows={8} value={edit[d.id] ?? d.content.text} onChange={(e) => setEdit({ ...edit, [d.id]: e.target.value })} />
              </div>
              <div className="row">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} data-testid={`ai-approve-${d.id}`}
                  onClick={async () => { setBusy(true); const r = await api(`/api/ai/drafts/${d.id}/review`, { body: { action: "approve", editedText: edit[d.id] ?? d.content.text, saveAsRecord: Boolean(target.caseId) } }); setBusy(false); if (!r.ok) setErr(errorText(r.error)); else router.refresh(); }}>
                  검토 완료·승인{target.caseId ? " (사례 기록으로 저장)" : ""}
                </button>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                  onClick={async () => { setBusy(true); const r = await api(`/api/ai/drafts/${d.id}/review`, { body: { action: "discard" } }); setBusy(false); if (!r.ok) setErr(errorText(r.error)); else router.refresh(); }}>
                  폐기
                </button>
              </div>
            </div>
          )}
          {d.status !== "draft" && <p className="panel-note" style={{ marginTop: 6 }}>처리자: {d.reviewer ?? "—"}</p>}
        </article>
      ))}
    </div>
  );
}
