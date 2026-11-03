"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SERVICE_TYPES, SERVICE_TYPE_LABEL, type ServiceType } from "@/lib/domain/enums";
import { api, errorText } from "./api";

type Item = { id?: string; serviceType: ServiceType; department: string; providerId?: string | null; frequency: string; startDate?: string | null; endDate?: string | null; method: string; notes: string };
type Plan = { planId?: string; expectedVersion?: number; goals: string; mainNeeds: string; recipientWishes: string; additionalChecks: string; startDate: string | null; reviewDate: string | null; items: Item[] };

export function PlanEditor({ caseId, initial, departments }: { caseId: string; initial: Plan; departments: Record<string, string> }) {
  const router = useRouter();
  const [p, setP] = useState<Plan>(initial.items.length ? initial : { ...initial, items: [{ serviceType: "meal", department: departments.meal ?? "", frequency: "", method: "", notes: "" }] });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const setItem = (i: number, patch: Partial<Item>) => setP({ ...p, items: p.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const T = (k: keyof Plan, label: string, req = false) => (
    <div className="field full"><label htmlFor={`pl-${k}`}>{label}{req && <span className="req" aria-hidden="true"> *</span>}</label>
      <textarea id={`pl-${k}`} rows={2} value={String(p[k] ?? "")} onChange={(e) => setP({ ...p, [k]: e.target.value })} required={req} data-testid={`plan-${k}`} /></div>
  );
  return (
    <div className="stack">
      <div className="form-grid">
        {T("goals", "지원 목표", true)}
        {T("mainNeeds", "주요 욕구", true)}
        {T("recipientWishes", "대상자 희망")}
        {T("additionalChecks", "추가 확인 항목")}
        <div className="field"><label htmlFor="pl-start">예정 시작일</label><input id="pl-start" type="date" value={p.startDate ?? ""} onChange={(e) => setP({ ...p, startDate: e.target.value || null })} /></div>
        <div className="field"><label htmlFor="pl-review">종료 또는 재검토 예정일</label><input id="pl-review" type="date" value={p.reviewDate ?? ""} onChange={(e) => setP({ ...p, reviewDate: e.target.value || null })} /></div>
      </div>
      <h3>관련 서비스</h3>
      {p.items.map((it, i) => (
        <fieldset key={i} className="panel" style={{ padding: 12 }}>
          <legend style={{ fontWeight: 700, padding: "0 4px" }}>서비스 {i + 1}</legend>
          <div className="form-grid">
            <div className="field"><label htmlFor={`it-t-${i}`}>서비스 유형</label>
              <select id={`it-t-${i}`} value={it.serviceType} data-testid={`plan-item-type-${i}`} onChange={(e) => setItem(i, { serviceType: e.target.value as ServiceType, department: departments[e.target.value] ?? it.department })}>
                {SERVICE_TYPES.map((t) => <option key={t} value={t}>{SERVICE_TYPE_LABEL[t]}</option>)}
              </select></div>
            <div className="field"><label htmlFor={`it-d-${i}`}>담당 부서</label><input id={`it-d-${i}`} type="text" value={it.department} onChange={(e) => setItem(i, { department: e.target.value })} /></div>
            <div className="field"><label htmlFor={`it-f-${i}`}>제공 주기<span className="req" aria-hidden="true"> *</span></label><input id={`it-f-${i}`} type="text" placeholder="예: 주 2회" value={it.frequency} data-testid={`plan-item-freq-${i}`} onChange={(e) => setItem(i, { frequency: e.target.value })} /></div>
            <div className="field"><label htmlFor={`it-m-${i}`}>수행 방법</label><input id={`it-m-${i}`} type="text" value={it.method} onChange={(e) => setItem(i, { method: e.target.value })} /></div>
            <div className="field"><label htmlFor={`it-s-${i}`}>시작일</label><input id={`it-s-${i}`} type="date" value={it.startDate ?? ""} onChange={(e) => setItem(i, { startDate: e.target.value || null })} /></div>
            <div className="field"><label htmlFor={`it-e-${i}`}>종료일</label><input id={`it-e-${i}`} type="date" value={it.endDate ?? ""} onChange={(e) => setItem(i, { endDate: e.target.value || null })} /></div>
          </div>
          {p.items.length > 1 && <div className="form-actions"><button type="button" className="btn btn-sm btn-danger" onClick={() => setP({ ...p, items: p.items.filter((_, j) => j !== i) })}>항목 삭제</button></div>}
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={() => setP({ ...p, items: [...p.items, { serviceType: "housework", department: departments.housework ?? "", frequency: "", method: "", notes: "" }] })}>서비스 항목 추가</button>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} data-testid="plan-save" onClick={async () => {
          setBusy(true); setMsg(null);
          const r = await api<{ planId: string; version: number }>(`/api/cases/${caseId}/plan`, { method: "PUT", body: p });
          setBusy(false);
          if (!r.ok) return setMsg({ ok: false, text: errorText(r.error) });
          setP({ ...p, planId: r.data.planId, expectedVersion: r.data.version });
          setMsg({ ok: true, text: "지원계획을 저장했습니다." });
          router.refresh();
        }}>지원계획 저장</button>
      </div>
      <div role="status" aria-live="polite">{msg && <div className={`alert ${msg.ok ? "alert-ok" : "alert-error"}`}>{msg.text}</div>}</div>
    </div>
  );
}
