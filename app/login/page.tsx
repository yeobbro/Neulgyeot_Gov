import { redirect } from "next/navigation";
import { LoginForms } from "./LoginForms";
import { getDb, storageMode } from "@/lib/server/db/client";
import { demoLoginEnabled } from "@/lib/server/auth/session";
import { listDemoAccounts } from "@/lib/server/services/auth";
import { currentActor } from "@/lib/server/page";
import { ROLE_LABEL } from "@/lib/domain/enums";

export const dynamic = "force-dynamic";
export const metadata = { title: "로그인" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  if (await currentActor().catch(() => null)) redirect("/");
  const sp = await searchParams;
  const demo = demoLoginEnabled();
  const accounts = demo ? await listDemoAccounts(await getDb()) : [];
  const mode = storageMode();
  return (
    <div className="login">
      <section className="login-side" aria-label="서비스 안내">
        <div>
          <p style={{ fontSize: 12, color: "#8fa0bf" }}>KREWX · Neulgyeot Care Intelligence</p>
          <h1 style={{ marginTop: 8 }}>늘곁 지자체용</h1>
          <p style={{ marginTop: 8 }}>지역사회 통합돌봄 신청 접수부터 조사·개인별 지원계획·서비스 연계·모니터링까지 담당자 업무를 지원합니다.</p>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
          <li>신청 → 조사·종합판정 → 개인별 지원계획 → 서비스 제공·연계 → 모니터링</li>
          <li>병원 퇴원 연계는 승인된 API 계약(DEMO v1.0)으로만 수신</li>
          <li>AI·규칙 기반 추천은 담당자 검토용 초안이며 행정 판단을 대체하지 않습니다</li>
        </ul>
        <p style={{ fontSize: 12, color: "#8fa0bf" }}>공식 행정 시스템 또는 법정 판정을 대체하지 않는 MVP입니다.</p>
      </section>
      <main className="login-main" id="main">
        <h2 style={{ fontSize: 20 }}>로그인</h2>
        {sp.expired && <div className="alert alert-warn" style={{ marginTop: 12 }}>세션이 만료되었거나 계정이 비활성화되었습니다. 다시 로그인해 주세요.</div>}
        {!mode.persistent && <div className="alert alert-warn" style={{ marginTop: 12 }}>DEMO 환경 — 인메모리 데이터베이스(합성 데이터, 재시작 시 초기화)</div>}
        <LoginForms
          demo={demo}
          accounts={accounts.map((a) => ({ id: a.id, name: a.display_name, tenant: a.tenant_name, org: a.org, roles: a.roles.map((r) => ROLE_LABEL[r]).join(", "), active: a.is_active }))}
        />
      </main>
    </div>
  );
}
