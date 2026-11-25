/**
 * Local LLM provider (on-premise inference) for administrative drafts.
 *
 * Talks to any OpenAI-compatible chat endpoint that runs INSIDE the institution's network or on the same
 * machine: Ollama (`http://127.0.0.1:11434`), vLLM, llama.cpp server, LM Studio … Only the base URL and the
 * model name change between them.
 *
 * What it does NOT change: Gov still decides which facts leave the FactBook (`selectSendableFacts`, default
 * deny), the data-class gate (synthetic only in this phase), and `composeDraft` re-verifies every proposed
 * sentence (cited ids must be facts sent in this request, `verifyDraft`, numeric/date evidence, Korean only).
 * The provider only proposes sentences; a human approves the result.
 *
 * Nothing from the prompt or the model output is logged or stored here.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DraftContent } from "../../domain/ai-draft";
import type { DraftKind } from "../services/ai";
import type { ProviderRecord } from "./fact-policy";
import { CircuitBreaker, ProviderUnavailable, type AIProvider, type ProviderDraft } from "./provider";

export const LOCAL_LLM_PROMPT_VERSION = "gov-local-llm-v1";

export type LocalLLMConfig = {
  /** e.g. http://127.0.0.1:11434 (Ollama) or https://llm.intra.example (vLLM). "/v1" is appended. */
  baseUrl: string;
  model: string;
  /** optional bearer token (vLLM --api-key, gateway). Ollama needs none. */
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
};

const KIND_GOAL: Record<DraftKind, string> = {
  referral_summary: "병원 퇴원 연계 신청을 지자체 담당자가 검토하기 위한 요약",
  social_opinion: "지역사회 통합돌봄 검토용 사회복지 종합 소견서 초안",
  meeting_brief: "통합지원회의에서 쓸 사례 요약과 확인할 질문",
};

export function buildMessages(kind: DraftKind, sectionTitles: string[], facts: readonly ProviderRecord[]) {
  const system = [
    "당신은 지자체 통합돌봄 담당 공무원의 문서 작성을 돕는 보조자입니다.",
    "규칙:",
    "1. 아래 '사실' 목록에 있는 내용만 사용합니다. 추측하거나 새로운 사실·수치·날짜를 만들지 않습니다.",
    "2. 모든 문장은 근거가 된 사실의 id를 factIds에 1개 이상 넣습니다. 문장 본문에는 id(F1 등)를 쓰지 않습니다.",
    "3. 복지 자격, 서비스 수급 여부, 긴급성, 위험도를 판단하지 않습니다. 진단명·예후를 새로 쓰지 않습니다.",
    "4. 대상자에게 불리한 낙인 표현을 쓰지 않습니다. 객관적이고 중립적인 공공 행정 문체(~습니다)로 씁니다.",
    "5. 한국어로만 씁니다. 숫자는 사실에 적힌 그대로 아라비아 숫자로 씁니다.",
    "6. 섹션 제목은 주어진 것을 그대로 쓰고 순서를 바꾸지 않습니다. 근거가 없는 섹션은 sentences를 빈 배열로 둡니다.",
    '출력은 JSON 하나만: {"sections":[{"title":"섹션 제목","sentences":[{"text":"문장","factIds":["F1"]}]}]}',
  ].join("\n");
  const user = [
    `작성 목적: ${KIND_GOAL[kind]}`,
    `섹션(순서대로): ${sectionTitles.map((t) => `"${t}"`).join(", ")}`,
    "사실:",
    ...facts.map((f) => `${f.id}: ${f.text}`),
  ].join("\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/** Permissive on shape (small local models drift), strict on content: every kept sentence is re-verified by composeDraft. */
const idList = z.array(z.unknown()).max(20).optional().transform((a) => (a ?? []).filter((x): x is string => typeof x === "string" && x.length <= 16));
const sentenceSchema = z.object({ text: z.unknown(), factIds: idList, fact_ids: idList, source_ids: idList }).passthrough();
const outputSchema = z.object({
  sections: z.array(z.object({ title: z.unknown(), sentences: z.array(z.unknown()).max(30).optional() }).passthrough()).max(12),
});
const chatSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })).min(1),
  model: z.string().max(160).optional(),
});

/** Removes inline citation markers a small model may copy into the sentence ("F1: …", "[F2]", "(F3, F4)"). */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(/^\s*F\d+\s*[:：.)\]-]\s*/u, "")
    .replace(/^\s*[[(（]\s*F\d+(?:\s*[,，]\s*F\d+)*\s*[\])）]\s*/u, "")
    .replace(/\s*[[(（]\s*F\d+(?:\s*[,，]\s*F\d+)*\s*[\])）]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Parses the model text into sections. Tolerates ```json fences and text around the JSON object. */
export function parseModelOutput(content: string): DraftContent["sections"] {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ProviderUnavailable("invalid_json", "로컬 LLM 응답에 JSON이 없습니다.");
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ProviderUnavailable("invalid_json", "로컬 LLM 응답 JSON 해석 실패");
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderUnavailable("invalid_response", "로컬 LLM 응답 형식 오류");
  return parsed.data.sections
    .filter((s): s is typeof s & { title: string } => typeof s.title === "string" && s.title.trim().length > 0 && s.title.length <= 120)
    .map((s) => ({
      title: s.title.trim(),
      sentences: (s.sentences ?? [])
        .map((x) => sentenceSchema.safeParse(x))
        .filter((r) => r.success && typeof r.data.text === "string" && r.data.text.length <= 600)
        .map((r) => {
          const d = r.data!;
          const ids = d.factIds.length ? d.factIds : d.fact_ids.length ? d.fact_ids : d.source_ids;
          return { text: stripCitationMarkers(d.text as string), factIds: [...new Set(ids)] };
        })
        .filter((x) => x.text.length >= 2),
    })) as DraftContent["sections"];
}

export class LocalLLMProvider implements AIProvider {
  readonly name = "local-llm" as const;
  readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  constructor(private cfg: LocalLLMConfig) {
    this.breaker = cfg.breaker ?? new CircuitBreaker();
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.base = cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
  }

  private headers() {
    return { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) };
  }

  async health() {
    try {
      const r = await this.fetchImpl(`${this.base}/models`, { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      if (!r.ok) return { ok: false, reason: `http_${r.status}` };
      const j = (await r.json()) as { data?: { id?: string }[] };
      const ids = (j.data ?? []).map((m) => m.id ?? "");
      const found = ids.some((id) => id === this.cfg.model || id === `${this.cfg.model}:latest` || `${id}:latest` === this.cfg.model);
      return found ? { ok: true, llmAvailable: true } : { ok: false, reason: "model_not_loaded", llmAvailable: false };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }

  async proposeDraft(input: { tenantId: string; kind: DraftKind; sectionTitles: string[]; facts: readonly ProviderRecord[]; traceId: string }): Promise<ProviderDraft> {
    if (!this.breaker.allow()) throw new ProviderUnavailable("circuit_open", "로컬 LLM 연속 실패로 일시 중단");
    try {
      const content = await this.chat(buildMessages(input.kind, input.sectionTitles, input.facts));
      const sections = parseModelOutput(content);
      if (!sections.some((s) => s.sentences.length)) throw new ProviderUnavailable("no_result", "로컬 LLM이 문장을 만들지 않았습니다.");
      return {
        requestId: `req_${randomBytes(10).toString("hex")}`,
        model: `local:${this.cfg.model}`.slice(0, 160),
        promptVersion: LOCAL_LLM_PROMPT_VERSION,
        engine: "local-llm",
        sections,
      };
    } finally {
      this.breaker.release();
    }
  }

  private async chat(messages: ReturnType<typeof buildMessages>): Promise<string> {
    const maxRetries = this.cfg.maxRetries ?? 1;
    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0.2,
      max_tokens: this.cfg.maxTokens ?? 1500,
      response_format: { type: "json_object" },
      stream: false,
    });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        if (!timeout && attempt < maxRetries) continue;
        this.breaker.failure();
        throw new ProviderUnavailable(timeout ? "timeout" : "network", timeout ? "로컬 LLM 응답 시간 초과" : "로컬 LLM 서버 연결 실패");
      }
      if (res.status === 503 && attempt < maxRetries) continue;
      if (res.status >= 500) {
        this.breaker.failure();
        throw new ProviderUnavailable(res.status === 503 ? "unavailable" : "server_error", `로컬 LLM 서버 오류 ${res.status}`, res.status);
      }
      if (!res.ok) {
        this.breaker.success(); // reachable; the request/config is wrong (e.g. unknown model → 404)
        throw new ProviderUnavailable(res.status === 404 ? "not_found" : res.status === 401 ? "unauthorized" : "client_error", `로컬 LLM 요청 거부 ${res.status}`, res.status);
      }
      const parsed = chatSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        this.breaker.failure();
        throw new ProviderUnavailable("invalid_response", "로컬 LLM 응답 형식 오류");
      }
      this.breaker.success();
      return parsed.data.choices[0].message.content ?? "";
    }
  }
}

/* --------------------------------------------------------------------------------------- configuration */
const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./];
/** http is allowed only to this machine or a private-network address literal; anything else must be https. */
export function isLocalNetworkHost(hostname: string) {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "host.docker.internal" || PRIVATE_V4.some((r) => r.test(h));
}

export function localLLMFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): LocalLLMProvider | null {
  const model = env.LOCAL_LLM_MODEL?.trim();
  if (!model) return null;
  const url = new URL(env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:11434");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalNetworkHost(url.hostname))) {
    throw new Error("LOCAL_LLM_BASE_URL must use https (http only for localhost or a private network address)");
  }
  const num = (v: string | undefined, d: number, min: number, max: number) => Math.min(Math.max(Number(v ?? d) || d, min), max);
  return new LocalLLMProvider({
    baseUrl: url.toString(),
    model,
    apiKey: env.LOCAL_LLM_API_KEY || undefined,
    timeoutMs: num(env.LOCAL_LLM_TIMEOUT_MS, 120_000, 1000, 600_000),
    maxTokens: num(env.LOCAL_LLM_MAX_TOKENS, 1500, 128, 8192),
    fetchImpl,
  });
}
