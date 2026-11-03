"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ANSWER_STATUSES, ANSWER_STATUS_LABEL, ASSESSMENT_DOMAINS, ASSESSMENT_DOMAIN_LABEL, type AnswerStatus, type AssessmentDomain } from "@/lib/domain/enums";
import { api, errorText } from "./api";

type Item = { domain: AssessmentDomain; answerStatus: AnswerStatus | null; value: string; note: string };
type Home = { housingType: string | null; barriers: string[]; heatingCooling: string | null; safetyNotes: string; modificationNeeded: boolean | null };
const BARRIERS = ["계단", "욕실 문턱", "현관 단차", "좁은 출입구", "손잡이 없음", "난방 불량"];

export function AssessmentEditor({ caseId, assessmentId, version, status, items, home, canWrite, canConfirm }: {
  caseId: string; assessmentId: string | null; version: number | null; status: string | null; items: Item[]; home: Home | null; canWrite: boolean; canConfirm: boolean;
}) {
  const router = useRouter();
  const init: Item[] = ASSESSMENT_DOMAINS.map((d) => items.find((i) => i.domain === d) ?? { domain: d, answerStatus: null, value: "", note: "" });
  const [rows, setRows] = useState(init);
  const [h, setH] = useState<Home>(home ?? { housingType: null, barriers: [], heatingCooling: null, safetyNotes: "", modificationNeeded: null });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ver, setVer] = useState<{ id: string | null; v: number | null }>({ id: assessmentId, v: version });
  const locked = status === "confirmed" || status === "submitted" || !canWrite;
  const set = (i: number, patch: Partial<Item>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function save() {
    const r = await api<{ assessmentId: string; version: number }>(`/api/cases/${caseId}/assessment`, { method: "PUT", body: { assessmentId: ver.id ?? undefined, expectedVersion: ver.v ?? undefined, items: rows, home: h } });
    if (r.ok) setVer({ id: r.data.assessmentId, v: r.data.version });
    return r;
  }
  async function run(fn: () => ReturnType<typeof api>, ok: string) {
    setBusy(true);
    setMsg(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setMsg({ ok: false, text: errorText(r.error) });
    else {
      setMsg({ ok: true, text: ok });
      router.refresh();
    }
  }
  return (
    <div className="stack">
      <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
        <table className="data">
          <caption>응답이 없거나 확인되지 않은 항목은 정상으로 처리하지 않습니다. 반드시 응답 상태를 선택하세요.</caption>
          <thead><tr><th scope="col">조사 영역</th><th scope="col">응답 상태</th><th scope="col" className="wrap">확인 내용</th><th scope="col" className="wrap">메모·추가 확인 계획</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.domain}>
                <th scope="row" style={{ fontWeight: 600 }}>{ASSESSMENT_DOMAIN_LABEL[r.domain]}</th>
                <td>
                  <label className="sr-only" htmlFor={`st-${r.domain}`}>{ASSESSMENT_DOMAIN_LABEL[r.domain]} 응답 상태</label>
                  <select id={`st-${r.domain}`} disabled={locked} value={r.answerStatus ?? ""} onChange={(e) => set(i, { answerStatus: (e.target.value || null) as AnswerStatus | null })} data-testid={`asm-status-${r.domain}`}>
                    <option value="">미기재</option>
                    {ANSWER_STATUSES.map((s) => <option key={s} value={s}>{ANSWER_STATUS_LABEL[s]}</option>)}
                  </select>
                </td>
                <td className="wrap">
                  <label className="sr-only" htmlFor={`v-${r.domain}`}>{ASSESSMENT_DOMAIN_LABEL[r.domain]} 확인 내용</label>
                  <textarea id={`v-${r.domain}`} rows={2} disabled={locked} value={r.value} maxLength={1000} onChange={(e) => set(i, { value: e.target.value })} data-testid={`asm-value-${r.domain}`} />
                </td>
                <td className="wrap">
                  <label className="sr-only" htmlFor={`n-${r.domain}`}>{ASSESSMENT_DOMAIN_LABEL[r.domain]} 메모</label>
                  <textarea id={`n-${r.domain}`} rows={2} disabled={locked} value={r.note} maxLength={500} onChange={(e) => set(i, { note: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <fieldset className="panel" style={{ padding: 12 }} disabled={locked}>
        <legend style={{ fontWeight: 700, padding: "0 4px" }}>주거 환경 조사</legend>
        <div className="form-grid">
          <div className="field"><label htmlFor="h-type">주거 형태</label><input id="h-type" type="text" value={h.housingType ?? ""} onChange={(e) => setH({ ...h, housingType: e.target.value || null })} /></div>
          <div className="field"><label htmlFor="h-heat">냉난방</label><input id="h-heat" type="text" value={h.heatingCooling ?? ""} onChange={(e) => setH({ ...h, heatingCooling: e.target.value || null })} /></div>
          <fieldset className="field full" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, color: "var(--text-2)", fontSize: 12.5 }}>장애요인</legend>
            <div className="checks">{BARRIERS.map((b) => <label key={b}><input type="checkbox" checked={h.barriers.includes(b)} onChange={(e) => setH({ ...h, barriers: e.target.checked ? [...h.barriers, b] : h.barriers.filter((x) => x !== b) })} /> {b}</label>)}</div>
          </fieldset>
          <div className="field full"><label htmlFor="h-safe">안전 관련 메모</label><textarea id="h-safe" rows={2} value={h.safetyNotes} onChange={(e) => setH({ ...h, safetyNotes: e.target.value })} /></div>
          <div className="field"><label htmlFor="h-mod">주거환경 개선 필요</label>
            <select id="h-mod" value={h.modificationNeeded === null ? "" : String(h.modificationNeeded)} onChange={(e) => setH({ ...h, modificationNeeded: e.target.value === "" ? null : e.target.value === "true" })}>
              <option value="">확인 필요</option><option value="true">필요</option><option value="false">불필요</option>
            </select>
          </div>
        </div>
      </fieldset>
      <div className="form-actions">
        {!locked && <button className="btn" type="button" disabled={busy} data-testid="asm-save" onClick={() => run(save, "조사 내용을 저장했습니다.")}>임시 저장</button>}
        {!locked && ver.id && <button className="btn btn-primary" type="button" disabled={busy} data-testid="asm-submit" onClick={() => run(async () => { const s = await save(); if (!s.ok) return s; return api(`/api/cases/${caseId}/assessment/${s.data.assessmentId}/submit`, { body: {} }); }, "검토 요청했습니다.")}>저장 후 검토 요청</button>}
        {status === "submitted" && canConfirm && <button className="btn btn-primary" type="button" disabled={busy} data-testid="asm-confirm" onClick={() => run(() => api(`/api/cases/${caseId}/assessment/${ver.id ?? assessmentId}/confirm`, { body: {} }), "평가를 확정했습니다.")}>검토 완료 · 평가 확정</button>}
      </div>
      <div role="status" aria-live="polite">{msg && <div className={`alert ${msg.ok ? "alert-ok" : "alert-error"}`} role={msg.ok ? undefined : "alert"}>{msg.text}</div>}</div>
    </div>
  );
}
