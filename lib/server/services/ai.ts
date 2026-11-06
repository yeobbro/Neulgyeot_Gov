/**
 * Administrative AI assistance (3 functions). Default engine is rule-based
 * and runs entirely on the server with no external calls. External LLM
 * inference is disabled pending the dedicated AI Intelligence adapter's
 * tenant, privacy, and evidence-validation integration tests.
 * All outputs are saved as `draft` and need human approval.
 */
import { z } from "zod";
import { ANSWER_STATUS_LABEL, ASSESSMENT_DOMAIN_LABEL, SERVICE_REFERRAL_STATUS_LABEL, SERVICE_TYPE_LABEL, TASK_TYPE_LABEL, type AnswerStatus, type AssessmentDomain, type ServiceType } from "../../domain/enums";
import { renderDraft, verifyDraft, type DraftContent, type Fact } from "../../domain/ai-draft";
import { matchProviders } from "../../domain/matching";
import type { Actor } from "../auth/session";
import { audit } from "../audit";
import { assertCaseRead, assertCaseWrite, isStaff } from "../authz";
import type { Db } from "../db/client";
import { newId } from "../db/ids";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { rateLimit } from "../http";
import { assertReferralWrite, getReferral } from "./referrals";

export type DraftKind = "referral_summary" | "social_opinion" | "meeting_brief";

/**
 * External LLM calls are deliberately disabled until the dedicated Neulgyeot
 * AI Intelligence provider adapter is integrated and its tenant-scoped
 * security contract is verified. Keep the rule engine as the safe fallback.
 */
export function llmAvailable(_tenantAiEnabled: boolean) {
  return false;
}

/** Presence indicator used instead of the note text (see referralFacts). */
export const SOCIAL_WORKER_NOTE_PRESENT = "병원 사회복지사 소견 첨부됨 (원문은 연계 상세 화면에서 권한자만 확인)";

class FactBook {
  facts: Fact[] = [];
  add(text: string, sourceType: string, sourceId: string, field: string) {
    const id = `F${this.facts.length + 1}`;
    this.facts.push({ id, text, sourceType, sourceId, field });
    return id;
  }
}

/* ------------------------------ fact gathering ------------------------------ */
async function referralFacts(tx: Db, actor: Actor, referralId: string) {
  const d = await getReferral(tx, actor, referralId);
  const fb = new FactBook();
  const vId = d.versions[0]?.id ?? referralId;
  const p = (d.payload ?? {}) as { discharge?: { plannedDate?: string | null }; functionalSummary?: Record<string, unknown>; livingNeeds?: { livingArrangement?: string; housingType?: string; barriers?: string[]; requestedServices?: string[]; socialWorkerNote?: string } };
  const facts = {
    discharge: p.discharge?.plannedDate ? fb.add(`퇴원 예정일 ${p.discharge.plannedDate}`, "referral_payload", vId, "discharge.plannedDate") : null,
    living: p.livingNeeds?.livingArrangement ? fb.add(`퇴원 후 동거 형태: ${p.livingNeeds.livingArrangement}`, "referral_payload", vId, "livingNeeds.livingArrangement") : null,
    housing: p.livingNeeds?.housingType ? fb.add(`주거 형태: ${p.livingNeeds.housingType}`, "referral_payload", vId, "livingNeeds.housingType") : null,
    barriers: p.livingNeeds?.barriers?.length ? fb.add(`주거 장애요인: ${p.livingNeeds.barriers.join(", ")}`, "referral_payload", vId, "livingNeeds.barriers") : null,
    services: p.livingNeeds?.requestedServices?.length ? fb.add(`요청 서비스: ${p.livingNeeds.requestedServices.join(", ")}`, "referral_payload", vId, "livingNeeds.requestedServices") : null,
    // The social worker's note is free text that may contain identifiers. Rule drafts only need to know
    // that it exists, so the fact records PRESENCE only — the note text never enters the FactBook, the stored
    // draft or the API response. AI providers never receive this fact either (fact-policy NEVER_SEND).
    note: p.livingNeeds?.socialWorkerNote?.trim() ? fb.add(SOCIAL_WORKER_NOTE_PRESENT, "referral_payload", vId, "livingNeeds.socialWorkerNote") : null,
    kadl: null as string | null,
    cognition: null as string | null,
  };
  const fs = p.functionalSummary as { kAdl?: { eating: string; mobility: string; toileting: string } | string; cognition?: string } | undefined;
  if (fs?.kAdl && typeof fs.kAdl === "object") facts.kadl = fb.add(`일상생활 기능(병원 제공): 식사 ${fs.kAdl.eating}, 이동 ${fs.kAdl.mobility}, 화장실 ${fs.kAdl.toileting}`, "referral_payload", vId, "functionalSummary.kAdl");
  if (fs?.cognition && !String(fs.cognition).startsWith("[")) facts.cognition = fb.add(`인지·의사소통(병원 제공): ${fs.cognition}`, "referral_payload", vId, "functionalSummary.cognition");
  const r = d.referral as unknown as { status: string; missing_items: string[]; region_name: string | null; consent_check_status: string };
  const status = fb.add(`연계 접수 상태: ${r.status}`, "incoming_referral", referralId, "status");
  const missing = r.missing_items?.length ? fb.add(`보완 요청 항목: ${r.missing_items.join(", ")}`, "incoming_referral", referralId, "missing_items") : null;
  const region = r.region_name ? fb.add(`담당 권역: ${r.region_name}`, "incoming_referral", referralId, "region_unit_id") : null;
  const pending = d.consent.filter((c) => c.decision === "pending_review");
  const pendingFact = pending.length ? fb.add(`법적 근거 검토 대기 항목: ${pending.map((c) => c.label).join(", ")}`, "consent_evidence", referralId, "decision") : null;
  return { fb, facts: { ...facts, status, missing, region, pendingFact } };
}

async function caseFacts(tx: Db, actor: Actor, caseId: string) {
  await assertCaseRead(tx, actor, caseId);
  const fb = new FactBook();
  const [c] = await tx.query<{ age_band: string | null; household_type: string | null; region_name: string; region_unit_id: string; status: string }>(
    `SELECT r.age_band, r.household_type, rg.name AS region_name, c.region_unit_id, c.status FROM care_cases c JOIN care_recipients r ON r.id = c.recipient_id JOIN region_units rg ON rg.id = c.region_unit_id WHERE c.id = $1`,
    [caseId],
  );
  const base = {
    age: c.age_band ? fb.add(`연령대: ${c.age_band}`, "care_recipient", caseId, "age_band") : null,
    household: c.household_type ? fb.add(`가구 형태: ${c.household_type}`, "care_recipient", caseId, "household_type") : null,
    region: fb.add(`거주 권역: ${c.region_name}`, "care_case", caseId, "region_unit_id"),
  };
  const [asm] = await tx.query<{ id: string; status: string }>(`SELECT id, status FROM needs_assessments WHERE case_id = $1 ORDER BY updated_at DESC LIMIT 1`, [caseId]);
  const items = asm
    ? await tx.query<{ domain: AssessmentDomain; answer_status: AnswerStatus | null; value: string; note: string }>(`SELECT domain, answer_status, value, note FROM assessment_items WHERE assessment_id = $1`, [asm.id])
    : [];
  const itemFacts: Partial<Record<AssessmentDomain, string>> = {};
  const unknown: string[] = [];
  for (const it of items) {
    if (it.answer_status === "confirmed" && it.value.trim()) itemFacts[it.domain] = fb.add(`${ASSESSMENT_DOMAIN_LABEL[it.domain]}: ${it.value.trim()}`, "assessment_item", asm.id, it.domain);
    else unknown.push(`${ASSESSMENT_DOMAIN_LABEL[it.domain]}(${it.answer_status ? ANSWER_STATUS_LABEL[it.answer_status] : "미기재"})`);
  }
  const answered = new Set(items.map((i) => i.domain));
  for (const dom of Object.keys(ASSESSMENT_DOMAIN_LABEL) as AssessmentDomain[]) if (!answered.has(dom)) unknown.push(`${ASSESSMENT_DOMAIN_LABEL[dom]}(미조사)`);
  const unknownFact = unknown.length ? fb.add(`확인되지 않은 조사 영역: ${unknown.join(", ")}`, "needs_assessment", asm?.id ?? caseId, "answer_status") : null;
  const [home] = asm ? await tx.query<{ housing_type: string | null; barriers: string[]; safety_notes: string }>(`SELECT housing_type, barriers, safety_notes FROM home_environment_assessments WHERE assessment_id = $1`, [asm.id]) : [];
  const homeFact = home?.barriers?.length ? fb.add(`주거환경 조사: ${home.housing_type ?? "형태 미기재"}, 장애요인 ${home.barriers.join(", ")}`, "home_environment", asm!.id, "barriers") : null;
  const [plan] = await tx.query<{ id: string; status: string }>(`SELECT id, status FROM support_plans WHERE case_id = $1 ORDER BY version_no DESC LIMIT 1`, [caseId]);
  const planItems = plan ? await tx.query<{ id: string; service_type: ServiceType; frequency: string }>(`SELECT id, service_type, frequency FROM support_plan_items WHERE plan_id = $1`, [plan.id]) : [];
  const planFact = planItems.length ? fb.add(`지원계획(${plan.status}) 포함 서비스: ${planItems.map((i) => `${SERVICE_TYPE_LABEL[i.service_type]} ${i.frequency}`).join(", ")}`, "support_plan", plan.id, "items") : null;
  return { fb, c, base, itemFacts, unknownFact, homeFact, plan, planItems, planFact };
}

/* ------------------------------ rule engines ------------------------------ */
const S = (text: string, ...ids: (string | null | undefined)[]) => {
  const factIds = ids.filter((x): x is string => Boolean(x));
  return factIds.length ? [{ text, factIds }] : [];
};

async function ruleReferralSummary(tx: Db, actor: Actor, referralId: string) {
  const { fb, facts: f } = await referralFacts(tx, actor, referralId);
  const content: DraftContent = {
    sections: [
      { title: "현재 확인된 주요 사실", sentences: [...S("퇴원 예정일이 전달되었습니다.", f.discharge), ...S("퇴원 후 동거 형태와 주거 형태가 전달되었습니다.", f.living, f.housing), ...S("병원이 제공한 일상생활 기능 정보가 있습니다(지자체 조사로 재확인 필요).", f.kadl), ...S("담당 권역이 지정되어 있습니다.", f.region)] },
      { title: "돌봄 욕구 및 요청 서비스", sentences: [...S("병원이 요청한 지역 서비스가 있습니다.", f.services), ...S("주거 장애요인이 보고되었습니다.", f.barriers), ...S("병원 사회복지사 소견이 첨부되었습니다.", f.note)] },
      { title: "누락·불일치 정보와 추가 확인 사항", sentences: [...S("보완 요청 중인 항목이 있습니다.", f.missing), ...S("법적 근거 검토가 끝나지 않은 항목은 열람·활용이 제한됩니다.", f.pendingFact), ...S("대상자 본인의 희망 서비스는 병원 자료에 없으므로 지자체 상담에서 확인해야 합니다.", f.status)] },
    ],
  };
  return { fb, content };
}

async function ruleSocialOpinion(tx: Db, actor: Actor, caseId: string) {
  const cf = await caseFacts(tx, actor, caseId);
  const { fb, base, itemFacts: it } = cf;
  // Candidate services: plan items + matching (review candidates only).
  const cand: string[] = [];
  if (cf.planItems.length) {
    const regions = await tx.query<{ id: string }>(`WITH RECURSIVE up AS (SELECT id, parent_id FROM region_units WHERE id = $1 UNION SELECT r.id, r.parent_id FROM region_units r JOIN up ON r.id = up.parent_id) SELECT id FROM up`, [cf.c.region_unit_id]);
    const providers = await tx.query<{ id: string; name: string; is_active: boolean; visit_days: string[]; is_synthetic: boolean }>(`SELECT id, name, is_active, visit_days, is_synthetic FROM service_providers`);
    const areas = await tx.query<{ provider_id: string; region_unit_id: string; service_type: ServiceType }>(`SELECT provider_id, region_unit_id, service_type FROM provider_service_areas`);
    for (const item of cf.planItems.slice(0, 4)) {
      const m = matchProviders(
        { serviceType: item.service_type, regionUnitIds: regions.map((r) => r.id) },
        providers.map((p) => ({ id: p.id, name: p.name, isActive: p.is_active, visitDays: p.visit_days, isSynthetic: p.is_synthetic, capacity: {}, serviceAreas: areas.filter((a) => a.provider_id === p.id).map((a) => ({ regionUnitId: a.region_unit_id, serviceType: a.service_type })) })),
        new Date(),
      );
      cand.push(fb.add(`${SERVICE_TYPE_LABEL[item.service_type]} 제공 권역 일치 기관 ${m.candidates.length}곳 (규칙 기반 후보, 수용 여부 별도 확인)`, "provider_match", item.id, "candidates"));
    }
  }
  const content: DraftContent = {
    sections: [
      { title: "대상자 주요 현황", sentences: [...S("대상자의 연령대와 거주 권역이 확인되었습니다.", base.age, base.region), ...S("가구 형태가 기록되어 있습니다.", base.household, it.household), ...S("기본 특성 조사 내용이 있습니다.", it.basic_profile)] },
      { title: "현재 확인된 기능 및 일상생활 지원 필요", sentences: [...S("이동 및 일상생활 관련 조사 결과가 있습니다.", it.mobility_adl), ...S("식사·영양 관련 지원 필요가 조사되었습니다.", it.nutrition), ...S("보건의료 서비스 이용·연계 필요가 조사되었습니다.", it.health_service_use), ...S("장기요양 및 돌봄 욕구가 조사되었습니다.", it.ltc_care_needs)] },
      { title: "주거·돌봄 환경", sentences: [...S("주거 환경 조사 결과가 있습니다.", it.housing, cf.homeFact), ...S("가족 돌봄 부담에 관한 조사 내용이 있습니다.", it.family_burden), ...S("사회적 관계 관련 조사 내용이 있습니다.", it.social_relations)] },
      { title: "대상자가 희망하는 서비스", sentences: [...S("대상자 본인이 밝힌 희망 사항이 기록되어 있습니다.", it.recipient_wishes)] },
      { title: "확인이 더 필요한 사항", sentences: [...S("일부 조사 영역은 확인되지 않았거나 응답이 없어 추가 확인이 필요합니다.", cf.unknownFact)] },
      { title: "검토할 수 있는 지역 서비스 후보", sentences: [...S("현재 지원계획에 포함된 서비스가 있습니다.", cf.planFact), ...cand.map((id) => ({ text: "해당 서비스의 권역 내 제공기관 후보가 확인되었습니다(담당자 검토 필요).", factIds: [id] }))] },
    ],
  };
  return { fb, content };
}

async function ruleMeetingBrief(tx: Db, actor: Actor, caseId: string) {
  const cf = await caseFacts(tx, actor, caseId);
  const { fb } = cf;
  const recent = await tx.query<{ id: string; record_type: string; occurred_at: string }>(`SELECT id, record_type, occurred_at FROM case_records WHERE case_id = $1 AND NOT is_deleted ORDER BY occurred_at DESC LIMIT 3`, [caseId]);
  const recentFacts = recent.map((r) => fb.add(`최근 기록: ${new Date(r.occurred_at).toISOString().slice(0, 10)} ${r.record_type}`, "case_record", r.id, "occurred_at"));
  const svc = await tx.query<{ id: string; referral_no: string; status: keyof typeof SERVICE_REFERRAL_STATUS_LABEL; service_type: ServiceType }>(`SELECT id, referral_no, status, service_type FROM service_referrals WHERE case_id = $1`, [caseId]);
  const gapFacts = svc.filter((s) => ["UNAVAILABLE", "REASSESSMENT_REQUIRED", "REQUESTED"].includes(s.status)).map((s) => fb.add(`${s.referral_no} ${SERVICE_TYPE_LABEL[s.service_type]}: ${SERVICE_REFERRAL_STATUS_LABEL[s.status]}`, "service_referral", s.id, "status"));
  const unref = cf.planItems.filter((i) => !svc.some((s) => s.service_type === i.service_type)).map((i) => fb.add(`지원계획 항목 '${SERVICE_TYPE_LABEL[i.service_type]}' 의뢰 이력 없음`, "support_plan_item", i.id, "service_type"));
  const tasks = await tx.query<{ id: string; task_type: keyof typeof TASK_TYPE_LABEL; due_at: string | null }>(`SELECT id, task_type, due_at FROM action_tasks WHERE case_id = $1 AND status = 'open'`, [caseId]);
  const taskFacts = tasks.map((t) => fb.add(`미완료 업무: ${TASK_TYPE_LABEL[t.task_type]}${t.due_at ? ` (기한 ${new Date(t.due_at).toISOString().slice(0, 10)})` : ""}`, "action_task", t.id, "status"));
  const content: DraftContent = {
    sections: [
      { title: "사례 타임라인 요약", sentences: [...S("최근 상담·방문 기록이 있습니다.", ...recentFacts), ...S("현재 지원계획 내용이 있습니다.", cf.planFact)] },
      { title: "서비스 연계 공백", sentences: [...S("회신 대기·수행 불가·재연계 필요 의뢰가 있습니다.", ...gapFacts), ...S("의뢰되지 않은 지원계획 항목이 있습니다.", ...unref)] },
      { title: "미완료 후속 업무", sentences: [...S("처리되지 않은 후속 업무가 있습니다.", ...taskFacts)] },
      { title: "회의에서 확인할 질문", sentences: [...S("확인되지 않은 조사 영역을 회의에서 어떻게 보완할지 논의가 필요합니다.", cf.unknownFact), ...S("대상자 희망과 지원계획 항목이 일치하는지 확인이 필요합니다.", cf.itemFacts.recipient_wishes, cf.planFact)] },
    ],
  };
  return { fb, content };
}

/* ------------------------------ AI providers ------------------------------ */
// The former direct call to an external LLM API (llmRewrite) was removed: it was unreachable because
// llmAvailable() returns false, and it sent unescaped fact text to an external service. AI proposals now go
// through lib/server/ai/provider.ts (local AI Intelligence, tenant-scoped tokens, allowlisted facts only),
// which is not wired into this route yet. See docs/AI_PROVIDER_INTEGRATION.md.

/* ------------------------------ public API ------------------------------ */
/** A draft has exactly ONE target, fixed by its kind: referral_summary → referralId only; the others → caseId only.
 * Allowing both let a user attach a case they can write to a referral they can only read (and so approve it). */
export const generateBody = z
  .object({ kind: z.enum(["referral_summary", "social_opinion", "meeting_brief"]), caseId: z.string().min(1).optional(), referralId: z.string().min(1).optional() })
  .refine((b) => (b.kind === "referral_summary" ? Boolean(b.referralId) && !b.caseId : Boolean(b.caseId) && !b.referralId), {
    message: "초안 종류에 맞는 대상 하나만 지정해야 합니다 (연계 요약: referralId, 그 외: caseId).",
  });

/**
 * Gathers facts (with the actor's read authorisation) and builds the rule draft. Pure DB reads, no network.
 * Exported so a provider-based flow can run it in a short transaction and call the AI provider outside it.
 */
export async function buildDraft(tx: Db, actor: Actor, b: z.infer<typeof generateBody>): Promise<{ facts: Fact[]; content: DraftContent }> {
  if (!isStaff(actor)) throw forbidden();
  if (b.caseId && b.referralId) throw invalid("초안 대상은 하나만 지정할 수 있습니다.");
  let built: { fb: FactBook; content: DraftContent };
  if (b.kind === "referral_summary") {
    if (!b.referralId) throw invalid("referralId가 필요합니다.");
    built = await ruleReferralSummary(tx, actor, b.referralId);
  } else {
    if (!b.caseId) throw invalid("caseId가 필요합니다.");
    built = b.kind === "social_opinion" ? await ruleSocialOpinion(tx, actor, b.caseId) : await ruleMeetingBrief(tx, actor, b.caseId);
  }
  return { facts: built.fb.facts, content: built.content };
}

export async function generateDraft(tx: Db, actor: Actor, b: z.infer<typeof generateBody>) {
  if (!isStaff(actor)) throw forbidden();
  rateLimit(`ai:${actor.id}`, 20, 60_000);
  const built = await buildDraft(tx, actor, b);
  // Rule engine only: external/remote inference stays disabled in this route (llmAvailable() === false).
  const content = built.content;
  const engine = "rules" as const;
  const check = verifyDraft(content, built.facts);
  if (!check.ok) throw invalid("초안 검증에 실패했습니다.", { problems: check.problems });
  const id = newId("aid");
  const stored = { ...content, facts: built.facts, text: renderDraft(content) };
  // a rule draft is the root of its own review group (AI proposals made from it join this group)
  await tx.query(`INSERT INTO ai_drafts (id, tenant_id, case_id, referral_id, kind, engine, status, content, created_by, draft_group_id) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$1)`, [
    id, actor.tenantId, b.kind === "referral_summary" ? null : b.caseId!, b.kind === "referral_summary" ? b.referralId! : null, b.kind, engine, JSON.stringify(stored), actor.id,
  ]);
  let si = 0;
  for (const sec of content.sections)
    for (const sen of sec.sentences) {
      si++;
      for (const fid of sen.factIds) {
        const f = built.facts.find((x) => x.id === fid)!;
        await tx.query(`INSERT INTO ai_source_references (id, tenant_id, draft_id, sentence_index, source_type, source_id, field) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [newId("asr"), actor.tenantId, id, si, f.sourceType, f.sourceId, f.field]);
      }
    }
  await audit(tx, actor, "ai.generate", { type: "ai_draft", id }, "success", { kind: b.kind, engine, facts: built.facts.length });
  return { id, engine, ...stored };
}

export async function listDrafts(tx: Db, actor: Actor, target: { caseId?: string; referralId?: string }) {
  if (target.caseId) await assertCaseRead(tx, actor, target.caseId);
  else if (target.referralId) await getReferral(tx, actor, target.referralId);
  else throw invalid("대상이 필요합니다.");
  return tx.query(
    `SELECT d.id, d.kind, d.engine, d.status, d.content, d.edited_text, d.created_at, d.reviewed_at, d.draft_group_id, d.selection_status, d.selected_at, d.source_job_id, u.display_name AS creator, ru.display_name AS reviewer
       FROM ai_drafts d JOIN users u ON u.id = d.created_by LEFT JOIN users ru ON ru.id = d.reviewed_by
      WHERE ${target.caseId ? "d.case_id = $1" : "d.referral_id = $1"} ORDER BY d.created_at DESC LIMIT 20`,
    [target.caseId ?? target.referralId],
  );
}

export const reviewBody = z.object({ action: z.enum(["approve", "discard"]), editedText: z.string().trim().min(10).max(6000).optional(), saveAsRecord: z.boolean().default(false) });

/**
 * Explicit permission check for reviewing an AI draft. Reading a draft is NOT enough to approve or discard it.
 *   approve / discard a case draft     → assertCaseWrite   (municipal admin, or a case manager assigned to the case)
 *   approve / discard a referral draft → assertReferralWrite (municipal admin, or the case manager assigned to the referral)
 * Both actions currently map to the same write rule; they are separate entries so they can diverge later
 * (e.g. allowing the author to discard) without touching callers. Other tenants: RLS hides the draft (404).
 */
export const DRAFT_REVIEW_RULES = {
  approve: { case: "case.write", referral: "referral.write" },
  discard: { case: "case.write", referral: "referral.write" },
} as const;

export async function assertDraftReview(tx: Db, actor: Actor, d: { case_id: string | null; referral_id: string | null; kind?: string }, action: "approve" | "discard") {
  if (!isStaff(actor)) throw notFound("초안");
  // exactly one target, and it must be the one the kind implies — a draft carrying both is never reviewable
  if ((d.case_id && d.referral_id) || (!d.case_id && !d.referral_id)) throw notFound("초안");
  if (d.kind && (d.kind === "referral_summary") !== Boolean(d.referral_id)) throw notFound("초안");
  const rule = DRAFT_REVIEW_RULES[action];
  if (d.case_id && rule.case === "case.write") return assertCaseWrite(tx, actor, d.case_id);
  if (d.referral_id && rule.referral === "referral.write") return assertReferralWrite(tx, actor, d.referral_id);
  throw notFound("초안");
}

export async function reviewDraft(tx: Db, actor: Actor, draftId: string, b: z.infer<typeof reviewBody>) {
  const [d] = await tx.query<{ case_id: string | null; referral_id: string | null; status: string; content: { text: string }; kind: DraftKind; draft_group_id: string; selection_status: string }>(
    `SELECT case_id, referral_id, status, content, kind, draft_group_id, selection_status FROM ai_drafts WHERE id = $1`, [draftId]);
  if (!d) throw notFound("초안");
  await assertDraftReview(tx, actor, d, b.action);
  // lock the whole group in id order: approve / discard / select on the same group serialise here
  const lockQ = `SELECT id, status, selection_status FROM ai_drafts WHERE draft_group_id = $1 ORDER BY id FOR UPDATE`;
  await tx.query(lockQ, [d.draft_group_id]);
  // second read: sees a sibling committed while we waited for the lock (READ COMMITTED statement snapshot)
  const group = await tx.query<{ id: string; status: string; selection_status: string }>(lockQ, [d.draft_group_id]);
  const me = group.find((g) => g.id === draftId)!;
  if (me.status !== "draft") throw conflict("이미 처리된 초안입니다.");
  if (b.action === "approve") {
    if (group.some((g) => g.status === "approved")) throw conflict("이 비교 그룹에는 이미 승인된 초안이 있습니다.");
    const others = group.filter((g) => g.id !== draftId && g.status === "draft");
    // with competing drafts, only the SELECTED one may be approved (selection ≠ approval; both are recorded)
    if (others.length && me.selection_status !== "selected") throw conflict("비교 중인 초안이 있습니다. 사용할 초안을 먼저 선택하세요.");
    await tx.query(`UPDATE ai_drafts SET selection_status = 'set_aside', selected_by = NULL, selected_at = NULL WHERE draft_group_id = $1 AND id <> $2 AND status = 'draft'`, [d.draft_group_id, draftId]);
    await tx.query(
      `UPDATE ai_drafts SET status = 'approved', edited_text = $2, reviewed_by = $3, reviewed_at = now(),
              selection_status = 'selected', selected_by = COALESCE(selected_by, $3), selected_at = COALESCE(selected_at, now()) WHERE id = $1`,
      [draftId, b.editedText ?? null, actor.id]);
  } else {
    await tx.query(`UPDATE ai_drafts SET status = 'discarded', reviewed_by = $2, reviewed_at = now(), selection_status = 'set_aside', selected_by = NULL, selected_at = NULL WHERE id = $1`, [draftId, actor.id]);
  }
  const status = b.action === "approve" ? "approved" : "discarded";
  // only an APPROVED draft can become an official case record
  if (b.action === "approve" && b.saveAsRecord && d.case_id) {
    const body = `[검토 승인된 ${d.kind === "social_opinion" ? "사회복지 종합 소견" : "회의 자료"} — 담당자 확인]\n${b.editedText ?? d.content.text}`.slice(0, 4000);
    await tx.query(`INSERT INTO case_records (id, tenant_id, case_id, record_type, body, occurred_at, author_id) VALUES ($1,$2,$3,'note',$4,now(),$5)`, [newId("rec"), actor.tenantId, d.case_id, body, actor.id]);
  }
  await audit(tx, actor, b.action === "approve" ? "ai.approve" : "ai.discard", { type: "ai_draft", id: draftId }, "success", {
    edited: Boolean(b.editedText), target: d.case_id ? "case" : "referral", kind: d.kind, group: d.draft_group_id,
  });
  return { status };
}
