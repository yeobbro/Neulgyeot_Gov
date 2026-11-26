"use client";
/**
 * 통합 관제 지도. OSM raster tiles + absolutely positioned markers (Web Mercator), no map library.
 * Two layers: "실시간 위치" (current position where consented and fresh; otherwise the designated location, drawn dashed)
 * and "지정 위치" (designated locations only). Coordinates never leave the page; tile requests reveal only the viewport.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  LOCATION_REASON_LABEL, SERVICE_GROUPS, SUBJECT_STATUSES, SUBJECT_STATUS_COLOR, SUBJECT_STATUS_LABEL, serviceGroupOf,
  type ServiceGroupKey, type SubjectStatus,
} from "@/lib/domain/control";
import type { Subject } from "@/lib/server/services/control";
import { api, errorText } from "./api";

const TILE = 256;
const lon2x = (lng: number, z: number) => ((lng + 180) / 360) * TILE * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / (TILE * 2 ** z)) * 360 - 180;
const y2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

type Layer = "current" | "designated";
type Candidates = Record<string, { id: string; name: string }[]>;

function pointOf(s: Subject, layer: Layer): { lat: number; lng: number; live: boolean } | null {
  if (s.location.mode === "none") return null;
  if (layer === "current" && s.location.mode === "current") return { lat: s.location.lat, lng: s.location.lng, live: true };
  if (s.location.mode === "designated") return { lat: s.location.lat, lng: s.location.lng, live: false };
  return null; // designated layer, but only a current position is known → not shown on the designated layer
}

export function ControlMap({ subjects, candidates, canDispatch, focus }: { subjects: Subject[]; candidates: Candidates; canDispatch: boolean; focus?: string }) {
  const [layer, setLayer] = useState<Layer>("current");
  const [statuses, setStatuses] = useState<Set<SubjectStatus>>(new Set(SUBJECT_STATUSES));
  const [groups, setGroups] = useState<Set<ServiceGroupKey | "none">>(new Set([...SERVICE_GROUPS.map((g) => g.key), "none"]));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });

  const bounds = useMemo(() => {
    const pts = subjects.map((s) => pointOf(s, "designated") ?? pointOf(s, "current")).filter(Boolean) as { lat: number; lng: number }[];
    if (!pts.length) return { lat: 37.4951, lng: 127.06278 };
    return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length };
  }, [subjects]);
  const [view, setView] = useState({ lat: bounds.lat, lng: bounds.lng, z: 13 });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = subjects.filter((s) => {
    if (!statuses.has(s.status)) return false;
    const gs = s.services.map(serviceGroupOf);
    if (!(gs.length ? gs.some((g) => groups.has(g)) : groups.has("none"))) return false;
    const q = query.trim();
    if (q && !`${s.name} ${s.caseCode} ${s.region}`.includes(q)) return false;
    return true;
  });

  const cx = lon2x(view.lng, view.z);
  const cy = lat2y(view.lat, view.z);
  // whole pixels: identical on server and client render (no hydration attribute mismatch)
  const left = Math.round(cx - size.w / 2);
  const top = Math.round(cy - size.h / 2);
  const tiles: { key: string; x: number; y: number; src: string }[] = [];
  const n = 2 ** view.z;
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size.w) / TILE); tx++)
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size.h) / TILE); ty++)
      if (ty >= 0 && ty < n) tiles.push({ key: `${view.z}/${tx}/${ty}`, x: tx * TILE - left, y: ty * TILE - top, src: `https://tile.openstreetmap.org/${view.z}/${((tx % n) + n) % n}/${ty}.png` });

  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, .ctl-popup")) return;
    drag.current = { x: e.clientX, y: e.clientY, cx, cy };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, lng: x2lon(d.cx - (e.clientX - d.x), v.z), lat: y2lat(d.cy - (e.clientY - d.y), v.z) }));
  };
  const zoom = (dz: number) => setView((v) => ({ ...v, z: Math.min(17, Math.max(11, v.z + dz)) }));

  const sel = subjects.find((s) => s.caseId === selected) ?? null;
  const selPoint = sel ? pointOf(sel, layer) ?? pointOf(sel, "designated") ?? pointOf(sel, "current") : null;
  const toggle = <T,>(set: Set<T>, v: T, fn: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    fn(next);
  };
  const countOf = (st: SubjectStatus) => subjects.filter((s) => s.status === st).length;
  const liveCount = subjects.filter((s) => s.location.mode === "current").length;

  return (
    <div className="ctl-map-panel">
      <div className="ctl-tabs" role="tablist" aria-label="위치 표시 방식">
        <button role="tab" aria-selected={layer === "current"} onClick={() => setLayer("current")}>실시간 위치 현황</button>
        <button role="tab" aria-selected={layer === "designated"} onClick={() => setLayer("designated")}>지정 위치(거주지)</button>
        <span className="ctl-tab-note">
          {layer === "current"
            ? `실시간 위치 ${liveCount}명 · 위치정보 동의와 30분 이내 수신이 있을 때만 표시합니다. 나머지는 지정 위치(점선)로 표시합니다.`
            : "담당자가 등록한 거주지 근사 위치입니다. 실제 주소가 아닙니다."}
        </span>
      </div>
      <div className="ctl-map" ref={wrap} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)}
        onWheel={(e) => zoom(e.deltaY < 0 ? 1 : -1)} data-testid="control-map">
        {tiles.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={t.key} src={t.src} alt="" draggable={false} className="ctl-tile" style={{ left: t.x, top: t.y }} />
        ))}
        {visible.map((s) => {
          const p = pointOf(s, layer);
          if (!p) return null;
          const x = Math.round(lon2x(p.lng, view.z) - left);
          const y = Math.round(lat2y(p.lat, view.z) - top);
          if (x < -20 || y < -20 || x > size.w + 20 || y > size.h + 20) return null;
          return (
            <button key={s.caseId} type="button" className={`ctl-marker ${p.live ? "live" : "designated"} st-${s.status} ${selected === s.caseId ? "on" : ""}`}
              style={{ left: x, top: y, ["--c" as string]: SUBJECT_STATUS_COLOR[s.status] }} onClick={() => setSelected(s.caseId)}
              aria-label={`${s.name} ${s.ageBand ?? ""} ${SUBJECT_STATUS_LABEL[s.status]} · ${p.live ? "실시간 위치" : "지정 위치"}`} data-testid={`marker-${s.caseCode}`}>
              <MarkerIcon status={s.status} />
            </button>
          );
        })}

        <div className="ctl-overlay ctl-filters">
          <input type="search" placeholder="이름·사례번호·동 검색" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="대상자 검색" />
          <fieldset>
            <legend>대상자 표시</legend>
            {SUBJECT_STATUSES.map((st) => (
              <label key={st}><input type="checkbox" checked={statuses.has(st)} onChange={() => toggle(statuses, st, setStatuses)} />
                <span className="dot" style={{ background: SUBJECT_STATUS_COLOR[st] }} />{SUBJECT_STATUS_LABEL[st]} ({countOf(st)})</label>
            ))}
          </fieldset>
          <fieldset>
            <legend>서비스 유형</legend>
            {SERVICE_GROUPS.map((g) => (
              <label key={g.key}><input type="checkbox" checked={groups.has(g.key)} onChange={() => toggle(groups, g.key, setGroups)} />{g.label}</label>
            ))}
            <label><input type="checkbox" checked={groups.has("none")} onChange={() => toggle(groups, "none", setGroups)} />진행 서비스 없음</label>
          </fieldset>
        </div>
        <div className="ctl-overlay ctl-zoom">
          <button type="button" onClick={() => zoom(1)} aria-label="확대">+</button>
          <button type="button" onClick={() => zoom(-1)} aria-label="축소">−</button>
        </div>
        <div className="ctl-attrib">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · 위치·인물은 모두 합성 데이터</div>

        {sel && selPoint && (
          <Popup s={sel} x={Math.round(lon2x(selPoint.lng, view.z) - left)} y={Math.round(lat2y(selPoint.lat, view.z) - top)} live={selPoint.live}
            candidates={candidates[sel.regionId] ?? []} canDispatch={canDispatch} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}

function MarkerIcon({ status }: { status: SubjectStatus }) {
  if (status === "urgent") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a6 6 0 0 0-6 6v5H5v2h14v-2h-1v-5a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0Z" fill="#fff" /></svg>;
  if (status === "caution") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 6h2v8h-2zM11 16h2v2h-2z" fill="#fff" /></svg>;
  if (status === "in_service") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5 4 11h2v8h4v-5h4v5h4v-8h2Z" fill="#fff" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.2" fill="#fff" /><path d="M6 18a6 6 0 0 1 12 0Z" fill="#fff" /></svg>;
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
};

function Popup({ s, x, y, live, candidates, canDispatch, onClose }: { s: Subject; x: number; y: number; live: boolean; candidates: { id: string; name: string }[]; canDispatch: boolean; onClose: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const urgent = s.openAlerts.find((a) => a.severity === "urgent");
  const [reason, setReason] = useState(urgent ? `${urgent.message.slice(0, 80)} — 현장 확인 요청` : "상태 확인을 위한 현장 방문 요청");
  const [assignee, setAssignee] = useState(s.workerId ?? candidates[0]?.id ?? "");
  const r = s.reading;

  async function submit() {
    setBusy(true);
    setMsg(null);
    const res = await api(`/api/cases/${s.caseId}/dispatches`, { body: { reason, assigneeId: assignee || undefined, alertId: urgent?.id } });
    setBusy(false);
    if (!res.ok) return setMsg(errorText(res.error));
    setOpen(false);
    router.refresh();
  }

  return (
    <div className={`ctl-popup ${y < 340 ? "below" : ""}`} style={{ left: x, top: y }} role="dialog" aria-label={`${s.name} 상세`} data-testid="control-popup">
      <button type="button" className="ctl-x" onClick={onClose} aria-label="닫기">×</button>
      <div className="ctl-pop-head">
        <strong>{s.name}</strong> <span className="muted">({s.ageBand ?? "연령 미상"})</span>
        <span className="ctl-chip" style={{ background: SUBJECT_STATUS_COLOR[s.status] }}>{SUBJECT_STATUS_LABEL[s.status]}</span>
      </div>
      <div className="muted ctl-pop-sub">{s.caseCode} · {s.region} · 담당 {s.workerName ?? "미배정"}</div>
      <div className="muted ctl-pop-sub">
        {live ? `실시간 위치 · ${s.location.mode === "current" ? ago(s.location.at) : ""}` : s.location.mode === "designated" ? `지정 위치 표시 — ${LOCATION_REASON_LABEL[s.location.reason]}` : "위치 정보 없음"}
      </div>
      {r ? (
        <div className={`ctl-vitals ${r.fresh ? "" : "stale"}`}>
          <span title="심박">♥ {r.heartRate ?? "—"}{r.heartRate != null && " bpm"}</span>
          <span title="체온(기기 측정값)">🌡 {r.bodyTempC != null ? `${r.bodyTempC.toFixed(1)}℃` : "—"}</span>
          <span title="산소포화도">SpO₂ {r.spo2 != null ? `${r.spo2}%` : "—"}</span>
          <small>{ago(r.at)}{r.fresh ? "" : " · 갱신 지연"}</small>
        </div>
      ) : <div className="muted ctl-pop-sub">{!s.device ? "웨어러블 미연결" : s.device.realtime ? "수신된 측정값 없음" : `일 요약 기기 · 마지막 동기화 ${s.device.lastDailyAt ? ago(s.device.lastDailyAt) : "없음"}`}</div>}
      {s.device && <div className="muted ctl-pop-sub">기기: {s.device.profileLabel}</div>}
      {s.device && !s.device.fallSos && <div className="ctl-alert-line info">이 기기는 낙상·SOS·위치 기능이 없습니다. 긴급 호출은 별도 장비로 확인하세요.</div>}
      {s.openAlerts.map((a) => <div key={a.id} className={`ctl-alert-line ${a.severity}`}>{a.message}</div>)}
      {s.openSignals > 0 && <div className="ctl-alert-line caution">일 요약 확인 필요 신호 {s.openSignals}건</div>}
      {s.dispatch && <div className="ctl-alert-line info">출동 {s.dispatch.status === "requested" ? "요청됨" : s.dispatch.status === "accepted" ? "수락" : "현장 도착"} · {s.dispatch.assigneeName}</div>}
      <div className="ctl-pop-actions">
        <Link className="btn btn-sm" href={`/cases/${s.caseId}?tab=wearable`}>상세보기</Link>
        {canDispatch && !s.dispatch && <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen((v) => !v)} data-testid="dispatch-open">현장 출동요청</button>}
      </div>
      {open && (
        <div className="ctl-dispatch">
          <label>출동 담당자
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>요청 사유<textarea value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} rows={2} /></label>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || reason.trim().length < 2} onClick={submit} data-testid="dispatch-submit">요청 보내기</button>
          <small className="muted">119·응급안전안심서비스를 대신하지 않습니다. 생명이 위급하면 119에 먼저 신고하세요.</small>
        </div>
      )}
      {msg && <div className="ctl-alert-line urgent" role="alert">{msg}</div>}
    </div>
  );
}
