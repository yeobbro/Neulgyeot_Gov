import { redirect } from "next/navigation";
import { NavLinks, type NavItem } from "@/components/client/NavLinks";
import { LogoutButton } from "@/components/client/ApiForm";
import { ROLE_LABEL } from "@/lib/domain/enums";
import { primaryRole } from "@/lib/server/auth/session";
import { storageMode } from "@/lib/server/db/client";
import { withPage } from "@/lib/server/page";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { actor, counts } = await withPage(async (tx, actor) => {
    const isStaff = actor.roles.includes("municipal_admin") || actor.roles.includes("case_manager");
    let counts = { referrals: 0, tasks: 0, provider: 0 };
    if (isStaff) {
      const [r] = await tx.query<{ n: number }>(
        actor.roles.includes("municipal_admin")
          ? `SELECT count(*)::int AS n FROM incoming_referrals WHERE status IN ('RECEIVED','RESUBMITTED')`
          : `SELECT count(*)::int AS n FROM incoming_referrals WHERE status IN ('RECEIVED','RESUBMITTED','UNDER_REVIEW') AND assigned_user_id = $1`,
        actor.roles.includes("municipal_admin") ? [] : [actor.id],
      );
      const [t] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM action_tasks WHERE status = 'open' AND assignee_id = $1 AND due_at <= current_date + 1`, [actor.id]);
      counts = { ...counts, referrals: r?.n ?? 0, tasks: t?.n ?? 0 };
    }
    if (actor.providerId) {
      const [p] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_referrals WHERE provider_id = $1 AND status = 'REQUESTED'`, [actor.providerId]);
      counts.provider = p?.n ?? 0;
    }
    return { actor, counts };
  });
  const role = primaryRole(actor);
  if (!role) redirect("/login");
  const items: NavItem[] = [];
  const staff = actor.roles.includes("municipal_admin") || actor.roles.includes("case_manager");
  if (staff) {
    items.push(
      { href: "/dashboard", label: "통합 현황", group: "업무" },
      { href: "/referrals", label: "병원 연계 접수함", count: counts.referrals, group: "업무" },
      { href: "/cases", label: "사례관리", group: "업무" },
      { href: "/plans", label: "지원계획·통합지원회의", group: "업무" },
      { href: "/service-referrals", label: "서비스 의뢰·제공", group: "업무" },
      { href: "/tasks", label: "모니터링·후속 업무", count: counts.tasks, group: "업무" },
      { href: "/providers", label: "서비스 카탈로그·제공기관", group: "지역 자원" },
      { href: "/map", label: "지역 자원 지도", group: "지역 자원" },
      { href: "/reports", label: "보고서·통계", group: "관리" },
    );
  }
  if (actor.roles.includes("municipal_admin") || actor.roles.includes("auditor")) items.push({ href: "/audit", label: "감사 로그", group: "관리" });
  if (actor.roles.includes("municipal_admin")) items.push({ href: "/admin", label: "관리자 설정", group: "관리" });
  if (actor.roles.includes("service_provider")) items.push({ href: "/provider", label: "의뢰 수신함", count: counts.provider, group: "제공기관" }, { href: "/provider/capacity", label: "수용 현황 등록", group: "제공기관" });

  const mode = storageMode();
  return (
    <div className="shell">
      <a className="skip-link" href="#main">본문 바로가기</a>
      <aside className="sidebar">
        <div className="brand">
          <strong>늘곁 지자체용</strong>
          <span>Neulgyeot Municipality · 통합돌봄</span>
        </div>
        <NavLinks items={items} />
        <div className="sidebar-foot">KREWX · MVP v0.1<br />공식 행정시스템·법정 판정을 대체하지 않습니다.</div>
      </aside>
      <div className="main">
        {(!mode.persistent || actor.isDemoAccount) && (
          <div className="demo-banner" role="note">
            <strong>DEMO</strong>
            <span>모든 기관·대상자·지역은 합성 데이터입니다. 실제 개인정보를 입력하지 마세요.</span>
            {!mode.persistent && <span>· 저장소: 인메모리(서버 재시작 시 초기화)</span>}
          </div>
        )}
        <header className="topbar">
          <div className="who">
            <strong style={{ color: "var(--text)" }}>{actor.tenantName}</strong>
            <span>{actor.organizationName}</span>
          </div>
          <div className="who">
            <span>{actor.name}</span>
            <span className="badge b-blue">{ROLE_LABEL[role]}</span>
            <LogoutButton />
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
