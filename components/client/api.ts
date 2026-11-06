"use client";
export type ApiError = { code: string; message: string; details?: unknown };

export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...opts.headers, "x-ngm-csrf": "1" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    const err = (json as { error?: ApiError })?.error ?? { code: "http_" + res.status, message: "요청을 처리하지 못했습니다." };
    return { ok: false, error: err };
  }
  return { ok: true, data: json as T };
}

export function errorText(e: ApiError): string {
  const d = e.details as { issues?: { message: string }[]; fieldErrors?: Record<string, string[]> } | undefined;
  const extra = d?.issues?.map((i) => i.message) ?? (d?.fieldErrors ? Object.entries(d.fieldErrors).map(([k, v]) => `${k}: ${v.join(", ")}`) : []);
  return [e.message, ...extra].join(" · ");
}
