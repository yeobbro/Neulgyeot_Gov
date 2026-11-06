/** Local mock AI provider for tests (no network, no model). Cites the first record it receives. */
import type { ProviderRecord } from "../lib/server/ai/fact-policy";
import { ProviderUnavailable, type AIProvider, type ProviderDraft } from "../lib/server/ai/provider";

export type MockStep = "ok" | "network" | "unavailable" | "server_error" | "invalid_response" | "circuit_open" | "bad_ids" | { hangMs: number };

export class MockProvider implements AIProvider {
  readonly name = "ai-intelligence" as const;
  calls = 0;
  inputs: string[] = [];
  constructor(private steps: MockStep[] = []) {}
  async health() {
    return { ok: true };
  }
  async proposeDraft(input: { tenantId: string; sectionTitles: string[]; facts: readonly ProviderRecord[]; traceId: string }): Promise<ProviderDraft> {
    this.calls++;
    this.inputs.push(JSON.stringify(input));
    const step = this.steps.shift() ?? "ok";
    if (typeof step === "object") await new Promise((r) => setTimeout(r, step.hangMs));
    else if (step !== "ok" && step !== "bad_ids") throw new ProviderUnavailable(step, "raw provider detail tok-SECRET-123 010-1234-5678");
    const first = input.facts[0];
    const sentence = step === "bad_ids" ? { text: "근거 없는 문장입니다.", factIds: ["F_unknown"] } : { text: `${first.text} 내용이 확인되었습니다.`, factIds: [first.id] };
    return {
      sections: input.sectionTitles.map((title, i) => ({ title, sentences: i === 0 ? [sentence] : [] })),
      requestId: "req_0123456789abcdef0123", model: "mock-model", promptVersion: "mock-p1", engine: "mock",
    };
  }
}
