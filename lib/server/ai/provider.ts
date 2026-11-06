/**
 * AI provider abstraction for administrative drafts.
 *
 * Gov keeps authentication, tenant/region checks, FactBook building, the rule drafts, final verification,
 * storage, human approval and audit. A provider only proposes sentences; `composeDraft` decides what survives.
 *
 * IMPORTANT: `composeDraft` performs network I/O and must be called OUTSIDE a database transaction
 * (route() wraps handlers in withTenant(); calling it there would hold the transaction for the whole model call).
 * It is not wired into /api/ai/drafts yet — see docs/AI_PROVIDER_INTEGRATION.md.
 */
import { randomUUID } from "node:crypto";
import { verifyDraft, type DraftContent, type Fact } from "../../domain/ai-draft";
import type { DraftKind } from "../services/ai";
import { errorResponseSchema, healthResponseSchema, predictResponseSchema, summarizeRequestSchema, summarizeResponseSchema, CONTRACT_MAJOR } from "./contract";
import { selectSendableFacts, type ExcludedFact, type ProviderRecord } from "./fact-policy";

export type DraftEngine = "rules" | "ai-intelligence" | "hybrid";

export type ProviderDraft = { sections: DraftContent["sections"]; requestId: string; model: string | null; promptVersion: string; engine: string };

export interface AIProvider {
  readonly name: "rules" | "ai-intelligence";
  health(): Promise<{ ok: boolean; reason?: string; contractVersion?: string; llmAvailable?: boolean }>;
  /** Proposes sentences for the given section titles using only `facts`. Throws ProviderUnavailable on any problem. */
  proposeDraft(input: { tenantId: string; kind: DraftKind; sectionTitles: string[]; facts: readonly ProviderRecord[]; traceId: string }): Promise<ProviderDraft>;
}

export class ProviderUnavailable extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
  }
}

/* --------------------------------------------------------------------------------------- circuit breaker */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = -1;
  constructor(private threshold = 3, private cooldownMs = 30_000, private now: () => number = Date.now) {}
  allow() {
    return this.openedAt < 0 || this.now() - this.openedAt >= this.cooldownMs;
  }
  success() {
    this.failures = 0;
    this.openedAt = -1;
  }
  failure() {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
  get state(): "closed" | "open" | "half-open" {
    return this.openedAt < 0 ? "closed" : this.allow() ? "half-open" : "open";
  }
}

/* --------------------------------------------------------------------------------------- AI Intelligence client */
export type AIIntelligenceConfig = {
  baseUrl: string;
  /** one token per tenant; a tenant without a token never borrows another tenant's token */
  tokenForTenant: (tenantId: string) => string | undefined;
  timeoutMs?: number;
  maxRetries?: number;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
};

export class AIIntelligenceProvider implements AIProvider {
  readonly name = "ai-intelligence" as const;
  readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  constructor(private cfg: AIIntelligenceConfig) {
    this.breaker = cfg.breaker ?? new CircuitBreaker();
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async health() {
    try {
      const r = await this.fetchImpl(new URL("/health", this.cfg.baseUrl), { signal: AbortSignal.timeout(3000) });
      const h = healthResponseSchema.safeParse(await r.json());
      if (!h.success) return { ok: false, reason: "invalid_health_response" };
      if (!h.data.contract_version.startsWith(CONTRACT_MAJOR)) return { ok: false, reason: "contract_version_mismatch" };
      return { ok: h.data.status === "ok", contractVersion: h.data.contract_version, llmAvailable: h.data.llm_available };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }

  private async post(path: string, tenantId: string, traceId: string, body: unknown): Promise<unknown> {
    const token = this.cfg.tokenForTenant(tenantId);
    if (!token) throw new ProviderUnavailable("no_tenant_token", "이 기관에 대한 AI 토큰이 없습니다.");
    if (!this.breaker.allow()) throw new ProviderUnavailable("circuit_open", "AI 서비스 연속 실패로 일시 중단");
    const maxRetries = this.cfg.maxRetries ?? 1;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(new URL(path, this.cfg.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-tenant-id": tenantId, "x-product": "community", "x-request-id": traceId },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        if (!timeout && attempt < maxRetries) continue; // a timeout is never retried (the server may still be working)
        this.breaker.failure();
        throw new ProviderUnavailable(timeout ? "timeout" : "network", timeout ? "AI 응답 시간 초과" : "AI 서비스 연결 실패");
      }
      if (res.status === 503 && attempt < maxRetries) {
        const wait = Math.min(Number(res.headers.get("retry-after") ?? "1") || 1, 5) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status >= 500) {
        this.breaker.failure();
        throw new ProviderUnavailable("server_error", `AI 서비스 오류 ${res.status}`, res.status);
      }
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        // 4xx: our configuration or request is wrong — not retried and not counted against the service
        const err = errorResponseSchema.safeParse(json);
        throw new ProviderUnavailable(err.success ? err.data.error.code : "client_error", `AI 요청 거부 ${res.status}`, res.status);
      }
      if (res.headers.get("x-request-id") && res.headers.get("x-request-id") !== traceId) throw new ProviderUnavailable("trace_mismatch", "응답 추적 ID 불일치");
      this.breaker.success();
      return json;
    }
  }

  async proposeDraft(input: { tenantId: string; kind: DraftKind; sectionTitles: string[]; facts: readonly ProviderRecord[]; traceId: string }): Promise<ProviderDraft> {
    const req = summarizeRequestSchema.parse({
      data_class: "synthetic", task_kind: input.kind, sections: input.sectionTitles,
      records: input.facts.map((f) => ({ id: f.id, text: f.text, kind: "structured" })), allow_free_text: false,
    });
    const parsed = summarizeResponseSchema.safeParse(await this.post("/ai/v1/summarize", input.tenantId, input.traceId, req));
    if (!parsed.success) throw new ProviderUnavailable("invalid_response", "AI 응답 형식 오류");
    const r = parsed.data;
    if (r.status !== "ok") throw new ProviderUnavailable(r.reason ?? "no_result", "AI 결과 없음");
    return { requestId: r.request_id, model: r.model, promptVersion: r.prompt_version, engine: r.engine,
      sections: r.sections.map((s) => ({ title: s.title, sentences: s.sentences.map((x) => ({ text: x.text, factIds: x.source_ids })) })) as DraftContent["sections"] };
  }

  /** Research-only prediction. Callers must not use the result for decisions, alerts or prioritisation. */
  async predictResearchOnly(tenantId: string, modelId: string, subjectRef: string, features: Record<string, number>, traceId = randomUUID()) {
    const p = predictResponseSchema.safeParse(await this.post("/ai/v1/predict", tenantId, traceId, { data_class: "synthetic", model_id: modelId, subject_ref: subjectRef, features }));
    if (!p.success) throw new ProviderUnavailable("invalid_response", "예측 응답이 research_only가 아니거나 형식 오류");
    return p.data;
  }
}

/* --------------------------------------------------------------------------------------- sentence ↔ evidence */
const NUM = /\d+(?:\.\d+)?/g;
const norm = (n: string) => (n.includes(".") ? String(Number(n)) : String(Number.parseInt(n, 10)));
const numbersIn = (t: string) => new Set((t.match(NUM) ?? []).map(norm));
const HAN = /[一-鿿぀-ヿ]/g;
const HANGUL = /[가-힣]/g;

/** Checks Gov's verifyDraft does not cover: the sentence's numbers must occur in the facts it cites, and the
 * sentence must be Korean. (Semantic faithfulness cannot be fully verified automatically — humans approve.) */
export function sentenceEvidenceProblems(text: string, cited: Fact[]): string[] {
  const problems: string[] = [];
  const src = numbersIn(cited.map((f) => f.text).join(" "));
  const extra = [...numbersIn(text)].filter((n) => !src.has(n));
  if (extra.length) problems.push(`근거에 없는 수치 ${extra.join(",")}`);
  const han = (text.match(HAN) ?? []).length;
  if (han > 0 && han >= (text.match(HANGUL) ?? []).length * 0.2) problems.push("한국어가 아닌 문장");
  return problems;
}

/* --------------------------------------------------------------------------------------- composition */
export type ComposedDraft = {
  content: DraftContent;
  engine: DraftEngine;
  sectionEngines: DraftEngine[];
  fallbackReason: string | null;
  aiRequestId: string | null;
  model: string | null;
  promptVersion: string | null;
  traceId: string;
  rejected: string[];
  excludedFacts: ExcludedFact[];
};

/**
 * Rule draft is the floor: the result is never worse than today's behaviour. AI sentences survive only if they
 * cite facts that were actually SENT in this request, pass verifyDraft and the evidence checks. Section titles
 * always come from the rule draft; an AI section that ends up empty keeps the rule sentences.
 */
export async function composeDraft(args: {
  provider: AIProvider | null;
  tenantId: string;
  kind: DraftKind;
  facts: Fact[];
  ruleDraft: DraftContent;
  traceId?: string;
}): Promise<ComposedDraft> {
  const traceId = args.traceId ?? `trc_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const { sendable, excluded } = selectSendableFacts(args.facts);
  const base: ComposedDraft = {
    content: args.ruleDraft, engine: "rules", sectionEngines: args.ruleDraft.sections.map(() => "rules"), fallbackReason: null,
    aiRequestId: null, model: null, promptVersion: null, traceId, rejected: [], excludedFacts: excluded,
  };
  if (!args.provider || args.provider.name === "rules") return { ...base, fallbackReason: "ai_disabled" };
  if (!sendable.length) return { ...base, fallbackReason: "no_sendable_facts" };

  let proposal: ProviderDraft;
  try {
    proposal = await args.provider.proposeDraft({ tenantId: args.tenantId, kind: args.kind, sectionTitles: args.ruleDraft.sections.map((s) => s.title), facts: sendable, traceId });
  } catch (e) {
    return { ...base, fallbackReason: e instanceof ProviderUnavailable ? e.code : "provider_error" };
  }

  const sentIds = new Set(sendable.map((f) => f.id));
  const byId = new Map(args.facts.map((f) => [f.id, f]));
  const rejected: string[] = [];
  const sections = args.ruleDraft.sections.map((rs, si) => {
    const ai = proposal.sections.find((s) => s.title === rs.title);
    const keep = (ai?.sentences ?? []).filter((sen, k) => {
      const tag = `${si + 1}-${k + 1}`;
      if (!sen.factIds.length || sen.factIds.length > 8) return rejected.push(`${tag}: 근거 개수 오류`), false;
      const notSent = sen.factIds.filter((f) => !sentIds.has(f));
      if (notSent.length) return rejected.push(`${tag}: 요청에 없던 근거 ${notSent.join(",")}`), false;
      const v = verifyDraft({ sections: [{ title: rs.title, sentences: [sen] }] }, args.facts);
      if (!v.ok) return rejected.push(`${tag}: ${v.problems.join("; ")}`), false;
      const ev = sentenceEvidenceProblems(sen.text, sen.factIds.map((f) => byId.get(f)!));
      if (ev.length) return rejected.push(`${tag}: ${ev.join("; ")}`), false;
      return true;
    }).slice(0, 12);
    return keep.length ? { title: rs.title, sentences: keep, engine: "ai-intelligence" as const } : { ...rs, engine: "rules" as const };
  });
  const engines = sections.map((s) => s.engine);
  if (!engines.includes("ai-intelligence")) return { ...base, rejected, fallbackReason: "all_ai_sentences_rejected" };
  const content: DraftContent = { sections: sections.map(({ title, sentences }) => ({ title, sentences })) };
  const final = verifyDraft(content, args.facts);
  if (!final.ok) return { ...base, rejected: [...rejected, ...final.problems], fallbackReason: "final_verification_failed" };
  return {
    ...base, content, sectionEngines: engines, engine: engines.every((e) => e === "ai-intelligence") ? "ai-intelligence" : "hybrid",
    aiRequestId: proposal.requestId, model: proposal.model, promptVersion: proposal.promptVersion, rejected,
  };
}

/* --------------------------------------------------------------------------------------- configuration */
/** Reads provider settings. Default: rules only. No secrets are logged. Not called by any route yet. */
export function providerFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): AIProvider | null {
  if (env.AI_PROVIDER !== "ai_intelligence") return null;
  const url = env.AI_INTELLIGENCE_URL;
  if (!url) return null;
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("AI_INTELLIGENCE_URL must use https (http only for localhost)");
  let tokens: Record<string, string> = {};
  try {
    tokens = JSON.parse(env.AI_INTELLIGENCE_TENANT_TOKENS ?? "{}");
  } catch {
    throw new Error("AI_INTELLIGENCE_TENANT_TOKENS must be a JSON object {tenantId: token}");
  }
  const timeoutMs = Number(env.AI_INTELLIGENCE_TIMEOUT_MS ?? 20_000);
  return new AIIntelligenceProvider({ baseUrl: url, tokenForTenant: (t) => (Object.hasOwn(tokens, t) ? tokens[t] : undefined), timeoutMs, fetchImpl });
}
