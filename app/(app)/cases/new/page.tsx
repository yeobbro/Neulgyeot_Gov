import { PageHead, Panel } from "@/components/ui";
import { ApiForm } from "@/components/client/ApiForm";
import { withPage } from "@/lib/server/page";
import { listRegions } from "@/lib/server/services/admin";

export const metadata = { title: "신규 신청 등록" };

export default async function NewCase() {
  const regions = await withPage(async (tx, actor) => (await listRegions(tx)).filter((r) => r.level === "eupmyeondong" && (actor.regionScope === null || actor.regionScope.includes(r.id))), { roles: ["municipal_admin", "case_manager"] });
  return (
    <>
      <PageHead title="신규 신청 등록" crumbs={[{ href: "/cases", label: "사례관리" }]} desc="본인·가족 신청, 기관 의뢰, 발굴 사례를 등록합니다. 병원 퇴원 연계는 연계 접수함에서 접수합니다." />
      <Panel title="신청 정보">
        <div className="alert alert-warn" style={{ marginBottom: 12 }}>DEMO 환경에서는 실제 성명·연락처를 입력하지 마세요. 표시명은 업무용 가명입니다.</div>
        <ApiForm action="/api/cases" redirectTo="/cases/{caseId}" submitLabel="신청 등록" fields={[
          { name: "displayName", label: "대상자 표시명(가명)", type: "text", required: true },
          { name: "ageBand", label: "연령대", type: "select", options: ["60대", "70대", "80대", "90대 이상"].map((v) => ({ value: v, label: v })) },
          { name: "regionUnitId", label: "담당 권역", type: "select", required: true, options: regions.map((r) => ({ value: r.id, label: r.name })) },
          { name: "route", label: "신청 경로", type: "select", required: true, options: [{ value: "self_application", label: "본인·가족 신청" }, { value: "agency_referral", label: "기관 의뢰" }, { value: "outreach", label: "발굴(찾아가는 상담)" }] },
          { name: "applicantType", label: "신청인 구분", type: "select", required: true, options: [{ value: "self", label: "본인" }, { value: "family", label: "가족" }, { value: "agency", label: "기관" }, { value: "official", label: "공무원 발굴" }] },
          { name: "summary", label: "신청 요지", type: "textarea", maxLength: 500 },
        ]} />
      </Panel>
    </>
  );
}
