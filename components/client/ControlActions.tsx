"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";

/** Refreshes the server-rendered control view periodically (no websocket in Phase 1). Pauses while the tab is hidden. */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const [last, setLast] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
        setLast(new Date());
      }
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return (
    <span className="ctl-refresh" aria-live="polite">
      {seconds}초마다 자동 갱신 · 마지막{" "}
      {/* server and client clocks differ by a moment on first render */}
      <time suppressHydrationWarning>{last.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      <button type="button" className="btn btn-sm" onClick={() => { router.refresh(); setLast(new Date()); }}>지금 갱신</button>
    </span>
  );
}

/** 대응 시작 / 종결 for one control alert. Closing requires a short note. */
export function AlertActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const send = async (s: "in_progress" | "resolved") => {
    setErr(null);
    const r = await api(`/api/control-alerts/${id}`, { body: { status: s, note } });
    if (!r.ok) return setErr(errorText(r.error));
    setClosing(false);
    router.refresh();
  };
  return (
    <span className="ctl-alert-actions">
      {status === "open" && <button type="button" className="btn btn-sm" onClick={() => send("in_progress")} data-testid={`alert-start-${id}`}>대응 시작</button>}
      {!closing ? (
        <button type="button" className="btn btn-sm" onClick={() => setClosing(true)}>종결</button>
      ) : (
        <>
          <input aria-label="확인 내용" placeholder="확인 내용 (예: 전화 확인, 이상 없음)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn btn-sm btn-primary" disabled={note.trim().length < 2} onClick={() => send("resolved")}>종결 저장</button>
        </>
      )}
      {err && <small className="ctl-err" role="alert">{err}</small>}
    </span>
  );
}

/** The assignee advances a dispatch (수락 → 현장 도착 → 완료). */
export function DispatchActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const next = status === "requested" ? ["accepted", "수락"] : status === "accepted" ? ["on_site", "현장 도착"] : status === "on_site" ? ["completed", "완료"] : null;
  if (!next) return null;
  return (
    <span className="ctl-alert-actions">
      <button type="button" className="btn btn-sm btn-primary" onClick={async () => {
        const r = await api(`/api/dispatches/${id}`, { body: { status: next[0] } });
        if (!r.ok) return setErr(errorText(r.error));
        router.refresh();
      }}>{next[1]}</button>
      {err && <small className="ctl-err" role="alert">{err}</small>}
    </span>
  );
}
