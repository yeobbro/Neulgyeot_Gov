"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, errorText } from "@/components/client/api";

type Acc = { id: string; name: string; tenant: string; org: string; roles: string; active: boolean };

export function LoginForms({ demo, accounts }: { demo: boolean; accounts: Acc[] }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function done(r: Awaited<ReturnType<typeof api>>) {
    setBusy(false);
    if (!r.ok) return setErr(errorText(r.error));
    router.push("/");
    router.refresh();
  }
  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setErr(null);
    done(await api("/api/auth/login", { body: { email: fd.get("email"), password: fd.get("password") } }));
  }
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <form onSubmit={onPassword} className="stack" aria-label="계정 로그인">
        <div className="field"><label htmlFor="email">이메일</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
        <div className="field"><label htmlFor="password">비밀번호</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div>
        <button className="btn btn-primary" type="submit" disabled={busy}>로그인</button>
        <p className="panel-note">기관 SSO·외부 인증(IdP)은 연동 인터페이스만 준비되어 있으며 현재 연결되어 있지 않습니다.</p>
      </form>
      <div role="alert" aria-live="assertive">{err && <div className="alert alert-error">{err}</div>}</div>
      {demo && (
        <section aria-labelledby="demo-h" className="panel">
          <div className="panel-head"><h2 id="demo-h">DEMO 계정으로 시작</h2><span className="badge b-demo">개발·시연 환경 전용</span></div>
          <div className="panel-body account-list">
            {accounts.map((a) => (
              <button key={a.id} type="button" className="btn account" disabled={busy} data-testid={`demo-${a.id}`}
                onClick={async () => { setBusy(true); setErr(null); done(await api("/api/auth/demo-login", { body: { userId: a.id } })); }}>
                <span><strong>{a.name}</strong><br /><small style={{ color: "var(--text-3)" }}>{a.tenant} · {a.org}</small></span>
                <span className="badge b-gray">{a.roles}{a.active ? "" : " · 비활성"}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
