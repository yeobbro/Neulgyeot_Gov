"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "./api";

type Cand = { providerId: string; providerName: string; rank: number; reasons: string[]; cautions: string[]; capacity: { status: string; label: string; confirmedAt: string | null } };
type Result = { candidates: Cand[]; excluded: { providerId: string; providerName: string; reason: string }[]; notice: string };

export function MatchPanel({ caseId, planItemId, label }: { caseId: string; planItemId: string; label: string }) {
  const router = useRouter();
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="btn btn-sm" data-testid={`match-${planItemId}`} onClick={async () => { setErr(null); const r = await api<Result>(`/api/cases/${caseId}/match?planItemId=${planItemId}`); if (!r.ok) setErr(errorText(r.error)); else setRes(r.data); }}>
          {label} 제공기관 후보 확인
        </button>
      </div>
      {err && <div className="alert alert-error" role="alert">{err}</div>}
      {res && (
        <>
          <div className="alert alert-info">{res.notice}</div>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)">
            <table className="data">
              <thead><tr><th scope="col">선택</th><th scope="col">순위</th><th scope="col">기관</th><th scope="col">수용 상태</th><th scope="col" className="wrap">추천 이유</th><th scope="col" className="wrap">확인 필요</th></tr></thead>
              <tbody>
                {res.candidates.map((c) => (
                  <tr key={c.providerId}>
                    <td><input type="radio" name={`pick-${planItemId}`} aria-label={`${c.providerName} 선택`} value={c.providerId} checked={sel === c.providerId} onChange={() => setSel(c.providerId)} data-testid={`pick-${c.providerId}`} /></td>
                    <td className="num">{c.rank}</td><td>{c.providerName}</td>
                    <td><span className={`badge ${c.capacity.status === "available" ? "b-green" : c.capacity.status === "unknown" ? "b-gray" : "b-amber"}`}>{c.capacity.label}</span></td>
                    <td className="wrap"><ul style={{ margin: 0, paddingLeft: 16 }}>{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul></td>
                    <td className="wrap">{c.cautions.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{c.cautions.map((r) => <li key={r}>{r}</li>)}</ul> : "—"}</td>
                  </tr>
                ))}
                {res.candidates.length === 0 && <tr><td colSpan={6}><div className="empty">조건에 맞는 후보가 없습니다 — 서비스 공백으로 기록·보고됩니다.</div></td></tr>}
              </tbody>
            </table>
          </div>
          {res.excluded.length > 0 && <details className="disclosure"><summary>제외된 기관 {res.excluded.length}곳과 사유</summary><div><ul style={{ margin: 0, paddingLeft: 16 }}>{res.excluded.map((e) => <li key={e.providerId}>{e.providerName}: {e.reason}</li>)}</ul></div></details>}
          <div className="field"><label htmlFor={`note-${planItemId}`}>의뢰 내용 (담당자 검토 후 작성)<span className="req" aria-hidden="true"> *</span></label>
            <textarea id={`note-${planItemId}`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid={`sr-note-${planItemId}`} /></div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={!sel || busy} data-testid={`sr-create-${planItemId}`} onClick={async () => {
              setBusy(true); setErr(null);
              const r = await api(`/api/cases/${caseId}/service-referrals`, { body: { planItemId, providerId: sel, requestNote: note, send: true } });
              setBusy(false);
              if (!r.ok) return setErr(errorText(r.error));
              setRes(null); router.refresh();
            }}>의뢰서 생성·전송</button>
          </div>
        </>
      )}
    </div>
  );
}
