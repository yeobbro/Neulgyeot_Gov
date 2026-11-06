import { PageHead, Panel, Badge } from "@/components/ui";
import { ApiForm, ActionButton } from "@/components/client/ApiForm";
import { ROLE_LABEL, type Role } from "@/lib/domain/enums";
import { CATEGORY_LABEL, TRANSFER_CATEGORIES } from "@/lib/integrations/hospital/schema";
import { fmtDateTime } from "@/lib/format";
import { withPage } from "@/lib/server/page";
import { getSettings, listUsers } from "@/lib/server/services/admin";
import { storageMode } from "@/lib/server/db/client";

export const metadata = { title: "관리자 설정" };
export default async function AdminPage() {
  const d = await withPage(async (tx, a) => ({ users: await listUsers(tx, a), s: await getSettings(tx, a), me: a.id }), { roles: ["municipal_admin"] });
  const s = d.s.settings as any;
  const mode = storageMode();
  return (
    <>
      <PageHead title="관리자 설정" desc="담당자·조직, 업무 규칙, 수신 정책, AI 사용 여부를 관리합니다. 모든 변경은 감사 로그에 기록됩니다." />
      <div className="split">
        <Panel title="담당자 및 조직" id="users">
          <div className="table-wrap" tabIndex={0} role="region" aria-label="표 영역 (가로 스크롤)"><table className="data">
            <thead><tr><th scope="col">이름</th><th scope="col">소속</th><th scope="col">역할</th><th scope="col" className="wrap">담당 권역</th><th scope="col">최근 로그인</th><th scope="col">상태</th><th scope="col">처리</th></tr></thead>
            <tbody>{d.users.map((u: any) => (
              <tr key={u.id}>
                <td>{u.display_name}{u.is_demo_account && <> <span className="badge b-demo">DEMO</span></>}</td><td>{u.org}</td>
                <td>{(u.roles ?? []).map((r: Role) => ROLE_LABEL[r]).join(", ")}</td><td className="wrap">{(u.regions ?? []).join(", ") || "전체/해당 없음"}</td>
                <td>{fmtDateTime(u.last_login_at)}</td><td>{u.is_active ? <Badge tone="green">활성</Badge> : <Badge tone="gray">비활성</Badge>}</td>
                <td>{u.id !== d.me && <ActionButton action={`/api/admin/users/${u.id}/active`} body={{ active: !u.is_active }} label={u.is_active ? "비활성화" : "활성화"} tone={u.is_active ? "danger" : "default"} />}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Panel>
        <div className="stack">
          <Panel title="업무 규칙 및 정책" id="settings">
            <ApiForm action="/api/admin/settings" method="PUT" submitLabel="설정 저장" fields={[
              { name: "monitoringIntervalDays", label: "모니터링 주기(일)", type: "number", required: true, defaultValue: String(s.monitoring_interval_days) },
              { name: "capacityFreshDays", label: "수용 정보 유효 기간(일)", type: "number", required: true, defaultValue: String(s.capacity_fresh_days) },
              { name: "planApprovalRoles", label: "지원계획 승인 권한", type: "checks", defaultValue: s.plan_approval_roles, options: [{ value: "municipal_admin", label: "시·군·구 관리자" }, { value: "case_manager", label: "사례관리 담당자" }] },
              { name: "intakeAllowedCategories", label: "병원 연계 수신 항목 (최소수집)", type: "checks", defaultValue: s.intake_allowed_categories, options: TRANSFER_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })) },
              { name: "aiEnabled", label: "AI 초안 제안 요청 허용 (기본 꺼짐 · 합성 데이터만 전송 · AI 처리 서버 연결 필요)", type: "checkbox", defaultValue: s.ai_enabled },
            ]} />
          </Panel>
          <Panel title="운영 환경" id="env">
            <dl className="kv">
              <dt>저장소</dt><dd>{mode.persistent ? <Badge tone="green">Managed PostgreSQL</Badge> : <Badge tone="amber">인메모리 DEMO (비영구)</Badge>}</dd>
              <dt>AI 기능 플래그</dt><dd>{process.env.AI_FEATURE_ENABLED === "true" ? "켜짐" : "꺼짐 (규칙 기반만)"}</dd>
              <dt>실제 기관 연계</dt><dd>미연결 — mock adapter</dd>
              <dt>외부 IdP·SSO</dt><dd>미연결 — 인터페이스만 준비</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}
