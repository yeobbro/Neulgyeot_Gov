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

/** The only codes Gov stores or audits. A provider-chosen string is never persisted (it could carry data). */
export const KNOWN_PROVIDER_CODES = new Set([
  "no_tenant_token", "circuit_open", "timeout", "network", "unavailable", "server_error", "client_error", "trace_mismatch",
  "invalid_response", "no_result", "llm_disabled", "unauthorized", "forbidden", "tenant_mismatch", "rate_limited", "payload_too_large",
  "invalid_request", "real_data_refused", "provider_error",
  // AI Intelligence v1.1 prototype (ai_ext/server.py, tokens.py) — verified against the running prototype
  "token_expired", "token_revoked", "unauthenticated", "forbidden_scope", "real_data_blocked", "not_found", "input_too_large",
  "busy", "internal_error", "no_usable_records", "schema_invalid",
  // reasons the prototype copies from its LLM adapter (Neulgyeot-AI-Intelligence/llm/adapters.py)
  "invalid_json", "blocked", "llm_unavailable", "all_sentences_rejected",
]);
export const knownCode = (c: string | null | undefined) => (c && KNOWN_PROVIDER_CODES.has(c) ? c : "provider_error");
/** Codes only Gov itself may raise. A provider answer carrying one of them is NOT trusted (it could e.g. trigger
 * the circuit-open deferral, which refunds the attempt although a call was made). */
const GOV_CONTROL_CODES = new Set(["no_tenant_token", "circuit_open", "network", "unavailable", "server_error", "client_error", "trace_mismatch", "invalid_response"]);
/**
 * Maps a code taken from a provider RESPONSE. Codes that steer Gov's job control flow (retry: network/unavailable,
 * deferral: circuit_open) are only ever raised by Gov's own client. The prototype reports a server-side LLM outage
 * as reason "unavailable" — kept as the non-retried `llm_unavailable`. Known codes pass, anything else → provider_error.
 */
export const providerSuppliedCode = (c: string | null | undefined) =>
  c === "unavailable" ? "llm_unavailable" : c && KNOWN_PROVIDER_CODES.has(c) && !GOV_CONTROL_CODES.has(c) ? c : "provider_error";

export class ProviderUnavailable extends Error {
  public code: string;
  constructor(code: string, message: string, public status?: number) {
    super(message);
    this.code = knownCode(code);
  }
}

/* --------------------------------------------------------------------------------------- circuit breaker */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = -1;
  private probing = false;
  constructor(private threshold = 3, private cooldownMs = 30_000, private now: () => number = Date.now) {}
  /** Closed: always. Open: never until the cooldown passes. Half-open: exactly ONE probe at a time. */
  allow() {
    if (this.openedAt < 0) return true;
    if (this.now() - this.openedAt < this.cooldownMs || this.probing) return false;
    this.probing = true;
    return true;
  }
  success() {
    this.failures = 0;
    this.openedAt = -1;
    this.probing = false;
  }
  /** Ends a probe that finished without a verdict (any exit path not covered by success()/failure()). */
  release() {
    this.probing = false;
  }
  failure() {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
  /** Global per provider instance on purpose: an outage of the AI service affects every tenant equally. */
  get state(): "closed" | "open" | "half-open" {
    if (this.openedAt < 0) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
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
    try {
      return await this.send(path, tenantId, traceId, body, token);
    } finally {
      this.breaker.release(); // a half-open probe can never stay "in progress" (review finding)
    }
  }

  private async send(path: string, tenantId: string, traceId: string, body: unknown, token: string): Promise<unknown> {
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
        // 503 keeps its own code: it is the only HTTP status the async job queue reschedules
        throw new ProviderUnavailable(res.status === 503 ? "unavailable" : "server_error", `AI 서비스 오류 ${res.status}`, res.status);
      }
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        // 4xx: our configuration or request is wrong — not retried and not counted against the service
        const err = errorResponseSchema.safeParse(json);
        // the service answered, so it is reachable: close the breaker (also ends a half-open probe)
        this.breaker.success();
        throw new ProviderUnavailable(err.success ? providerSuppliedCode(err.data.error.code) : "client_error", `AI 요청 거부 ${res.status}`, res.status);
      }
      if (res.headers.get("x-request-id") && res.headers.get("x-request-id") !== traceId) {
        this.breaker.failure();
        throw new ProviderUnavailable("trace_mismatch", "응답 추적 ID 불일치");
      }
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
    if (r.status !== "ok") throw new ProviderUnavailable(r.reason ? providerSuppliedCode(r.reason) : "no_result", "AI 결과 없음");
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
const numbersIn = (t: string) => (t.match(NUM) ?? []).map(norm);
const HAN = /[一-鿿぀-ヿ]/g;
const HANGUL = /[가-힣]/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;
/** Korean number words (native and sino) followed by a counter. They bypass digit checks, so they are refused. */
const NUMBER_WORD = /(?:^|[^가-힣])(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰|십|백|천)\s*(?:번|회|차례|명|개|곳|가지|시간|분|일|주|달|개월|년|세|살|층|원|km|kg)(?![가-힣])/;
/** Dates as (y, m, d) tuples; "M월 D일" without a year matches any fact date with the same month/day. */
const FULL_DATE = /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/g;
const MONTH_DAY = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
/** Text with dates removed, so date digits can never be reused as counts/amounts. */
const withoutDates = (t: string) => t.replace(FULL_DATE, " ").replace(MONTH_DAY, " ");
function datesIn(t: string): { y: number | null; m: number; d: number }[] {
  const out: { y: number | null; m: number; d: number }[] = [];
  for (const x of t.matchAll(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/g)) out.push({ y: +x[1], m: +x[2], d: +x[3] });
  const rest = t.replace(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/g, " ");
  for (const x of rest.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) out.push({ y: null, m: +x[1], d: +x[2] });
  return out;
}

/** Checks Gov's verifyDraft does not cover (semantic faithfulness cannot be fully verified — humans approve):
 *  - text is NFKC-normalised first (full-width digits etc.)
 *  - every number must occur in ONE single cited fact (no mixing digits from different facts)
 *  - every date must equal a date in the cited facts as a (year, month, day) tuple (no swapped day/month)
 *  - number words with counters ("다섯 번") are refused because they cannot be checked
 *  - the sentence must be Korean (Hangul-dominant; no Han/Kana; little Latin) */
export function sentenceEvidenceProblems(raw: string, cited: Fact[]): string[] {
  const problems: string[] = [];
  const text = raw.normalize("NFKC");
  const facts = cited.map((f) => f.text.normalize("NFKC"));
  const nums = numbersIn(withoutDates(text));
  if (nums.length) {
    const fits = facts.some((ft) => {
      const have = numbersIn(withoutDates(ft));
      return nums.every((n) => have.includes(n));
    });
    if (!fits) {
      const all = new Set(facts.flatMap((ft) => numbersIn(withoutDates(ft))));
      const extra = [...new Set(nums.filter((n) => !all.has(n)))];
      problems.push(extra.length ? `근거에 없는 수치 ${extra.join(",")}` : "여러 근거의 수치를 섞은 문장");
    }
  }
  const factDates = facts.flatMap(datesIn);
  for (const dt of datesIn(text)) {
    const ok = factDates.some((f) => f.m === dt.m && f.d === dt.d && (dt.y === null || f.y === null || f.y === dt.y));
    if (!ok) problems.push(`근거와 다른 날짜 ${dt.y ?? ""}${dt.y ? "-" : ""}${dt.m}-${dt.d}`);
  }
  if (NUMBER_WORD.test(text)) problems.push("숫자를 글자로 쓴 표현(검증 불가)");
  const hangul = (text.match(HANGUL) ?? []).length;
  const han = (text.match(HAN) ?? []).length;
  const latin = (text.match(LATIN_WORD) ?? []).join("").length;
  if (han > 0 || hangul === 0 || latin > hangul * 0.3) problems.push("한국어가 아닌 문장");
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
  /** Required. Only "synthetic" data may leave Gov in this phase; anything else is blocked before any network call. */
  dataClass: "synthetic" | "real";
  traceId?: string;
}): Promise<ComposedDraft> {
  const traceId = args.traceId ?? `trc_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const { sendable, excluded } = selectSendableFacts(args.facts);
  const base: ComposedDraft = {
    content: args.ruleDraft, engine: "rules", sectionEngines: args.ruleDraft.sections.map(() => "rules"), fallbackReason: null,
    aiRequestId: null, model: null, promptVersion: null, traceId, rejected: [], excludedFacts: excluded,
  };
  if (!args.provider || args.provider.name === "rules") return { ...base, fallbackReason: "ai_disabled" };
  if (args.dataClass !== "synthetic") return { ...base, fallbackReason: "real_data_blocked" };
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
