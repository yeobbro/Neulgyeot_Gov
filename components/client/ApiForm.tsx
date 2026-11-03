"use client";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { api, errorText } from "./api";

export type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "textarea" | "select" | "date" | "datetime" | "number" | "checkbox" | "checks" | "lines" | "pairs" | "hidden";
  options?: { value: string; label: string }[];
  required?: boolean;
  help?: string;
  defaultValue?: string | boolean | string[];
  full?: boolean;
  placeholder?: string;
  maxLength?: number;
  emptyAs?: "omit" | "null";
  pairKeys?: [string, string];
};

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = value;
}

export function ApiForm({
  action, method = "POST", fields, submitLabel = "저장", extra, successMessage = "저장되었습니다.", redirectTo, danger, inline, testId,
}: {
  action: string; method?: string; fields: FieldSpec[]; submitLabel?: string; extra?: Record<string, unknown>; successMessage?: string;
  redirectTo?: string; danger?: boolean; inline?: boolean; testId?: string;
}) {
  const router = useRouter();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { ...(extra ?? {}) };
    for (const f of fields) {
      let v: unknown;
      if (f.type === "checkbox") v = fd.get(f.name) === "on";
      else if (f.type === "checks") v = fd.getAll(f.name).map(String);
      else {
        const raw = String(fd.get(f.name) ?? "").trim();
        if (!raw) {
          if (f.emptyAs === "null") setPath(body, f.name, null);
          continue;
        }
        if (f.type === "number") v = Number(raw);
        else if (f.type === "lines") v = raw.split("\n").map((s) => s.trim()).filter(Boolean);
        else if (f.type === "pairs") {
          const [a, b] = f.pairKeys ?? ["organization", "role"];
          v = raw.split("\n").map((s) => s.trim()).filter(Boolean).map((l) => {
            const [x, y] = l.split("|").map((s) => s.trim());
            return { [a]: x, [b]: y || "참석" };
          });
        } else v = raw;
      }
      setPath(body, f.name, v);
    }
    setBusy(true);
    setMsg(null);
    const r = await api<Record<string, unknown>>(action, { method, body });
    setBusy(false);
    if (!r.ok) {
      setMsg({ ok: false, text: errorText(r.error) });
      return;
    }
    setMsg({ ok: true, text: successMessage });
    if (redirectTo) {
      const to = redirectTo.replace(/\{(\w+)\}/g, (_, k) => String(r.data[k] ?? ""));
      router.push(to);
    } else router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate={false} data-testid={testId} aria-describedby={msg ? `${uid}-msg` : undefined}>
      <div className={inline ? "row" : "form-grid"} style={inline ? { alignItems: "flex-end" } : undefined}>
        {fields.map((f) => {
          const id = `${uid}-${f.name}`;
          if (f.type === "hidden") return <input key={f.name} type="hidden" name={f.name} defaultValue={String(f.defaultValue ?? "")} />;
          const label = (
            <span>
              {f.label}
              {f.required && <span className="req" aria-hidden="true"> *</span>}
              {f.help && <small> — {f.help}</small>}
            </span>
          );
          if (f.type === "checkbox")
            return (
              <div key={f.name} className={`field ${f.full ? "full" : ""}`}>
                <label className="checks" htmlFor={id}>
                  <input id={id} type="checkbox" name={f.name} defaultChecked={Boolean(f.defaultValue)} /> {f.label}
                </label>
              </div>
            );
          if (f.type === "checks")
            return (
              <fieldset key={f.name} className={`field ${f.full ? "full" : ""}`} style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontWeight: 600, color: "var(--text-2)", fontSize: 12.5, marginBottom: 4 }}>{f.label}</legend>
                <div className="checks">
                  {f.options?.map((o) => (
                    <label key={o.value}><input type="checkbox" name={f.name} value={o.value} defaultChecked={Array.isArray(f.defaultValue) && f.defaultValue.includes(o.value)} /> {o.label}</label>
                  ))}
                </div>
              </fieldset>
            );
          return (
            <div key={f.name} className={`field ${f.full || f.type === "textarea" || f.type === "lines" || f.type === "pairs" ? "full" : ""}`} style={inline ? { minWidth: 160 } : undefined}>
              <label htmlFor={id}>{label}</label>
              {f.type === "select" ? (
                <select id={id} name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? "")}>
                  {!f.required && <option value="">선택 안 함</option>}
                  {f.required && !f.defaultValue && <option value="" disabled>선택</option>}
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === "textarea" || f.type === "lines" || f.type === "pairs" ? (
                <textarea id={id} name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? "")} placeholder={f.placeholder} maxLength={f.maxLength} />
              ) : (
                <input id={id} name={f.name} type={f.type === "datetime" ? "datetime-local" : f.type} required={f.required} defaultValue={String(f.defaultValue ?? "")} placeholder={f.placeholder} maxLength={f.maxLength} />
              )}
            </div>
          );
        })}
        {inline && <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} type="submit" disabled={busy}>{busy ? "처리 중…" : submitLabel}</button>}
      </div>
      {!inline && (
        <div className="form-actions">
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} type="submit" disabled={busy}>{busy ? "처리 중…" : submitLabel}</button>
        </div>
      )}
      <div id={`${uid}-msg`} role={msg && !msg.ok ? "alert" : "status"} aria-live="polite" style={{ marginTop: msg ? 8 : 0 }}>
        {msg && <div className={`alert ${msg.ok ? "alert-ok" : "alert-error"}`}>{msg.text}</div>}
      </div>
    </form>
  );
}

/** One-click action (no browser dialogs). */
export function ActionButton({ action, body, label, tone = "default", redirectTo, testId }: { action: string; body?: unknown; label: string; tone?: "default" | "primary" | "danger"; redirectTo?: string; testId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row" style={{ display: "inline-flex" }}>
      <button
        type="button"
        data-testid={testId}
        className={`btn btn-sm ${tone === "primary" ? "btn-primary" : tone === "danger" ? "btn-danger" : ""}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          const r = await api<Record<string, unknown>>(action, { body: body ?? {} });
          setBusy(false);
          if (!r.ok) return setErr(errorText(r.error));
          if (redirectTo) router.push(redirectTo.replace(/\{(\w+)\}/g, (_, k) => String(r.data[k] ?? "")));
          else router.refresh();
        }}
      >
        {busy ? "처리 중…" : label}
      </button>
      {err && <span role="alert" className="alert alert-error" style={{ padding: "2px 8px" }}>{err}</span>}
    </span>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button className="btn btn-sm" type="button" onClick={async () => { await api("/api/auth/logout", { body: {} }); router.push("/login"); router.refresh(); }}>
      로그아웃
    </button>
  );
}
