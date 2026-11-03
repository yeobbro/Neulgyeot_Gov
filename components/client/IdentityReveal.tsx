"use client";
import { useState } from "react";
import { api, errorText } from "./api";

export function IdentityReveal({ caseId }: { caseId: string }) {
  const [data, setData] = useState<{ legal_name: string; birth_date: string | null; source_basis: string } | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  if (data) return <dl className="kv"><dt>성명</dt><dd>{data.legal_name}</dd><dt>생년월일</dt><dd>{data.birth_date?.slice(0, 10) ?? "—"}</dd><dt>수집 근거</dt><dd>{data.source_basis}</dd></dl>;
  return (
    <div className="stack">
      <p className="panel-note">직접식별정보는 업무 데이터와 분리 보관되며, 열람 시 감사 로그가 기록됩니다.</p>
      <div><button type="button" className="btn btn-sm" onClick={async () => { const r = await api<{ identity: typeof data }>(`/api/cases/${caseId}/identity`); if (!r.ok) setErr(errorText(r.error)); else setData(r.data.identity ?? null); }}>식별정보 열람 (기록됨)</button></div>
      {data === null && <p className="panel-note">저장된 식별정보 없음</p>}
      {err && <div className="alert alert-error" role="alert">{err}</div>}
    </div>
  );
}
