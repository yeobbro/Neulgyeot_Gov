"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "./api";

type Preview = {
  totalRows: number;
  eligibleRows: number;
  skippedRows: number;
  duplicateCodes: string[];
  warnings: string[];
  sample: Array<{ name: string; code: string; facilityType: string; address: string }>;
};

export function PublicProviderImport() {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(mode: "preview" | "import") {
    setBusy(true); setError(null); setMessage(null);
    const result = await api<{ preview?: Preview; inserted?: number; updated?: number; skipped?: number }>(
      "/api/providers/import", { body: { csv, mode } },
    );
    setBusy(false);
    if (!result.ok) { setError(errorText(result.error)); return; }
    if (mode === "preview" && result.data.preview) setPreview(result.data.preview);
    if (mode === "import") {
      setMessage(`가져오기 완료: 신규 ${result.data.inserted ?? 0}개 · 갱신 ${result.data.updated ?? 0}개 · 제외 ${result.data.skipped ?? 0}개. 모든 기관은 관리자 검증 전까지 매칭에서 제외됩니다.`);
      setPreview(null);
      router.refresh();
    }
  }

  return (
    <section className="panel" aria-labelledby="public-provider-import">
      <div className="panel-head"><h2 id="public-provider-import">공공데이터 기관 가져오기</h2><span className="badge b-demo">관리자 전용</span></div>
      <p className="panel-note">
        서울열린데이터광장의 “서울시 강남구 사회복지시설 목록(OA-20399)” CSV를 내려받아 붙여 넣으세요.
        주소가 강남구 관내로 확인되는 행만 가져옵니다. 원본의 시설장 개인 이름은 가져오지 않습니다.
      </p>
      <div className="row" style={{ flexWrap: "wrap", marginTop: 6 }}>
        <a className="btn btn-sm" href="https://data.seoul.go.kr/dataList/OA-20399/S/1/datasetView.do" aria-label="서울열린데이터광장 강남구 사회복지시설 목록 원본 데이터셋">공식 데이터 원본 열기 ↗</a>
        <span className="panel-note">출처표시 공공누리 제1유형 · 데이터 갱신일은 원본 페이지에서 확인</span>
      </div>
      <div className="field">
        <label htmlFor="provider-csv">CSV 내용</label>
        <textarea id="provider-csv" rows={8} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }}
          placeholder="시설명,시설코드,시설종류명(시설유형),시설종류상세명(시설종류),자치구(시)구분,시설장명,시군구코드,시군구명,시설주소,정원(수용인원),현인원,전화번호,우편번호&#10;..." />
      </div>
      <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <button className="btn" type="button" disabled={busy || csv.trim().length < 20} onClick={() => run("preview")}>{busy ? "처리 중…" : "가져오기 미리보기"}</button>
        <button className="btn btn-primary" type="button" disabled={busy || !preview || preview.eligibleRows === 0} onClick={() => run("import")}>미리보기 결과 가져오기</button>
      </div>
      {error && <div className="alert alert-error" role="alert" style={{ marginTop: 8 }}>{error}</div>}
      {message && <div className="alert alert-ok" role="status" style={{ marginTop: 8 }}>{message}</div>}
      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
            <strong>전체 {preview.totalRows}행</strong><strong>가져올 수 있음 {preview.eligibleRows}행</strong><strong>제외 {preview.skippedRows}행</strong>
          </div>
          {preview.sample.length > 0 && <div className="table-wrap" style={{ marginTop: 8 }}><table className="data">
            <thead><tr><th>기관명</th><th>유형</th><th>주소</th><th>원본 코드</th></tr></thead>
            <tbody>{preview.sample.map((r) => <tr key={r.code}><td>{r.name}</td><td>{r.facilityType}</td><td>{r.address}</td><td>{r.code}</td></tr>)}</tbody>
          </table></div>}
          <ul>{preview.warnings.map((w, i) => <li key={i} className="panel-note">{w}</li>)}</ul>
          {preview.duplicateCodes.length > 0 && <p className="panel-note">중복 코드: {preview.duplicateCodes.join(", ")}</p>}
        </div>
      )}
    </section>
  );
}

export function ProviderVerificationButton({ providerId, verified }: { providerId: string; verified: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <span>
    <button className={verified ? "btn btn-sm" : "btn btn-sm btn-primary"} type="button" disabled={busy}
      onClick={async () => {
        setBusy(true); setError(null);
        const result = await api(`/api/providers/${providerId}/verification`, { body: { verified: !verified } });
        setBusy(false);
        if (!result.ok) { setError(errorText(result.error)); return; }
        router.refresh();
      }}>{busy ? "처리 중…" : verified ? "검증 해제" : "기관 확인 완료"}</button>
    {error && <small role="alert">{error}</small>}
  </span>;
}
