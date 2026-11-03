import Link from "next/link";
import type { ReactNode } from "react";
import {
  CAPACITY_LABEL, CASE_STATUS_LABEL, PLAN_STATUS_LABEL, REFERRAL_STATUS_LABEL, SERVICE_REFERRAL_STATUS_LABEL,
  type CapacityStatus, type CaseStatus, type PlanStatus, type ReferralStatus, type ServiceReferralStatus,
} from "@/lib/domain/enums";

type Tone = "blue" | "teal" | "amber" | "red" | "green" | "gray";
export function Badge({ tone = "gray", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge b-${tone}`} title={title}>{children}</span>;
}
export const DemoTag = () => <span className="badge b-demo" title="합성 데이터">DEMO</span>;

const CASE_TONE: Partial<Record<CaseStatus, Tone>> = {
  APPLICATION_RECEIVED: "blue", PRE_SCREENING: "blue", SURVEY_IN_PROGRESS: "teal", ASSESSMENT_REVIEW: "amber", ASSESSMENT_COMPLETED: "teal",
  SUPPORT_PLAN_DRAFT: "teal", MEETING_SCHEDULED: "amber", SUPPORT_PLAN_APPROVED: "green", SERVICE_REFERRAL_PENDING: "amber", PROVIDER_ACCEPTED: "green",
  SERVICE_SCHEDULED: "green", SERVICE_ACTIVE: "green", MONITORING_DUE: "amber", PLAN_REVIEW: "red", CLOSED: "gray", WITHDRAWN: "gray",
};
export const CaseBadge = ({ s }: { s: string }) => <Badge tone={CASE_TONE[s as CaseStatus] ?? "gray"}>{CASE_STATUS_LABEL[s as CaseStatus] ?? s}</Badge>;
const REF_TONE: Partial<Record<ReferralStatus, Tone>> = { RECEIVED: "blue", VALIDATION_FAILED: "red", UNDER_REVIEW: "teal", NEEDS_INFORMATION: "amber", RESUBMITTED: "blue", ACCEPTED_FOR_ASSESSMENT: "green", DECLINED: "red", CLOSED: "gray" };
export const ReferralBadge = ({ s }: { s: string }) => <Badge tone={REF_TONE[s as ReferralStatus] ?? "gray"}>{REFERRAL_STATUS_LABEL[s as ReferralStatus] ?? s}</Badge>;
const PLAN_TONE: Partial<Record<PlanStatus, Tone>> = { DRAFT: "gray", REVIEW_REQUESTED: "blue", MEETING_SCHEDULED: "amber", NEEDS_REVISION: "red", APPROVED: "green", REFERRING: "teal", IN_PROGRESS: "green", CHANGE_REVIEW: "amber", CLOSED: "gray" };
export const PlanBadge = ({ s }: { s: string }) => <Badge tone={PLAN_TONE[s as PlanStatus] ?? "gray"}>{PLAN_STATUS_LABEL[s as PlanStatus] ?? s}</Badge>;
const SR_TONE: Partial<Record<ServiceReferralStatus, Tone>> = { DRAFT: "gray", REQUESTED: "blue", ACCEPTED: "teal", UNAVAILABLE: "red", SCHEDULED: "teal", STARTED: "green", COMPLETED: "gray", CANCELED: "gray", REASSESSMENT_REQUIRED: "amber" };
export const ServiceBadge = ({ s }: { s: string }) => <Badge tone={SR_TONE[s as ServiceReferralStatus] ?? "gray"}>{SERVICE_REFERRAL_STATUS_LABEL[s as ServiceReferralStatus] ?? s}</Badge>;
const CAP_TONE: Record<CapacityStatus, Tone> = { available: "green", limited: "amber", full: "red", unknown: "gray" };
export const CapacityBadge = ({ s, label }: { s: CapacityStatus; label?: string }) => <Badge tone={CAP_TONE[s]}>{label ?? CAPACITY_LABEL[s]}</Badge>;

export function PageHead({ title, desc, actions, crumbs }: { title: string; desc?: ReactNode; actions?: ReactNode; crumbs?: { href: string; label: string }[] }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && (
          <nav className="breadcrumb" aria-label="이동 경로">
            {crumbs.map((c, i) => (
              <span key={c.href}>{i > 0 && " / "}<Link href={c.href}>{c.label}</Link></span>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, note, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; note?: ReactNode; id?: string }) {
  return (
    <section className="panel" aria-labelledby={id}>
      {title && (
        <div className="panel-head">
          <h2 id={id}>{title}</h2>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
      {note && <div className="panel-body panel-note" style={{ paddingTop: 0 }}>{note}</div>}
    </section>
  );
}

export const Empty = ({ children = "데이터 없음" }: { children?: ReactNode }) => <div className="empty">{children}</div>;

export function Pager({ page, pageSize, total, base }: { page: number; pageSize: number; total: number; base: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => `${base}${base.includes("?") ? "&" : "?"}page=${p}`;
  return (
    <nav className="pager" aria-label="페이지">
      <span>총 {total}건 · {page}/{pages}쪽</span>
      {page > 1 && <Link className="btn btn-sm" href={href(page - 1)}>이전</Link>}
      {page < pages && <Link className="btn btn-sm" href={href(page + 1)}>다음</Link>}
    </nav>
  );
}

export function Tabs({ items, current }: { items: { key: string; label: string; href: string }[]; current: string }) {
  return (
    <nav className="tabs" aria-label="사례 상세 탭">
      {items.map((t) => (
        <Link key={t.key} href={t.href} aria-current={t.key === current ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}

export function Bars({ rows, label }: { rows: { label: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <Empty>집계 대상 없음 (0건)</Empty>;
  return (
    <div className="bars" role="list" aria-label={label}>
      {rows.map((r) => (
        <div className="bar-row" role="listitem" key={r.label}>
          <span title={r.label} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
          <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: `${(r.value / max) * 100}%`, display: "block" }} /></span>
          <span className="num" style={{ textAlign: "right" }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
