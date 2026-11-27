/**
 * Contract test: the request Gov actually sends must validate against the AI Intelligence v1.1 OpenAPI document
 * (tests/fixtures/ai-intelligence-openapi.v1.1.json, a read-only copy of the prototype's contract), and every error
 * code / no-result reason the prototype can emit must be handled deliberately. No network: fetch is captured.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RETRYABLE, DEFERRABLE } from "../../lib/server/ai/jobs";
import { AIIntelligenceProvider, composeDraft, KNOWN_PROVIDER_CODES, providerSuppliedCode } from "../../lib/server/ai/provider";
import { summarizeRequestSchema } from "../../lib/server/ai/contract";

const openapi = JSON.parse(readFileSync(new URL("../fixtures/ai-intelligence-openapi.v1.1.json", import.meta.url), "utf8"));
const codes = JSON.parse(readFileSync(new URL("../fixtures/ai-intelligence-v1.1-codes.json", import.meta.url), "utf8")) as Record<string, string[]>;
const S = openapi.components.schemas as Record<string, any>;

/** Minimal JSON-Schema check for the keywords the contract uses (type/required/additionalProperties/pattern/…). */
function validate(schema: any, v: unknown, path = "$"): string[] {
  if (schema.$ref) return validate(S[schema.$ref.split("/").pop()], v, path);
  if (schema.anyOf) return schema.anyOf.some((s: any) => validate(s, v, path).length === 0) ? [] : [`${path}: matches no anyOf branch`];
  const errs: string[] = [];
  const t = schema.type;
  if (t === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${path}: not an object`];
    for (const r of schema.required ?? []) if (!(r in (v as object))) errs.push(`${path}.${r}: required`);
    for (const [k, val] of Object.entries(v as object)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], val, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not allowed by the contract`);
    }
  } else if (t === "array") {
    if (!Array.isArray(v)) return [`${path}: not an array`];
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems}`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems}`);
    if (schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
  } else if (t === "string") {
    if (typeof v !== "string") return [`${path}: not a string`];
    if (schema.minLength !== undefined && v.length < schema.minLength) errs.push(`${path}: too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) errs.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: does not match ${schema.pattern}`);
    if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: not in enum`);
  } else if (t === "boolean" && typeof v !== "boolean") errs.push(`${path}: not a boolean`);
  else if (t === "integer" && !Number.isInteger(v)) errs.push(`${path}: not an integer`);
  return errs;
}

const FACTS = [
  { id: "F1", text: "퇴원 예정일 2026-11-20", sourceType: "referral_payload", sourceId: "v1", field: "discharge.plannedDate" },
  { id: "F2", text: "연계 접수 상태: NEEDS_INFORMATION", sourceType: "incoming_referral", sourceId: "ir_x", field: "status" },
  { id: "F3", text: "병원 사회복지사 소견 첨부됨 (원문은 연계 상세 화면에서 권한자만 확인)", sourceType: "referral_payload", sourceId: "v1", field: "livingNeeds.socialWorkerNote" },
];
const RULE = { sections: [{ title: "현재 확인된 주요 사실", sentences: [{ text: "퇴원 예정일이 전달되었습니다.", factIds: ["F1"] }] }, { title: "추가 확인 사항", sentences: [] }] };

test("contract document: v1.1 paths used by Gov exist and SummarizeIn is closed (additionalProperties false)", () => {
  assert.match(openapi.info?.version ?? "", /^1\.1/);
  for (const p of ["/health", "/ai/v1/summarize", "/ai/v1/predict"]) assert.ok(openapi.paths[p], p);
  assert.equal(S.SummarizeIn.additionalProperties, false);
  assert.equal(S.RecordIn.additionalProperties, false);
});

test("the request Gov builds validates against SummarizeIn and carries only allowlisted structured records", async () => {
  const bodies: unknown[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = (async (_u: URL, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    headers.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify({ request_id: "req_00000000000000000001", trace_id: "t", status: "no_result", reason: "llm_disabled", engine: "rules", model: null, prompt_version: "p", sections: [], requires_human_review: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new AIIntelligenceProvider({ baseUrl: "http://127.0.0.1:1", tokenForTenant: () => "tok-test-tenant-0001", fetchImpl });
  const r = await composeDraft({ provider: p, tenantId: "tn_gaon", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "synthetic", traceId: "trc_contract_001" });
  assert.equal(r.fallbackReason, "llm_disabled");
  assert.equal(bodies.length, 1);
  assert.deepEqual(validate(S.SummarizeIn, bodies[0]), [], "request violates the v1.1 contract");
  const b = bodies[0] as { data_class: string; records: { id: string; kind: string }[]; allow_free_text: boolean };
  assert.equal(b.data_class, "synthetic");
  assert.equal(b.allow_free_text, false);
  assert.ok(b.records.every((x) => x.kind === "structured"));
  assert.ok(!b.records.some((x) => x.id === "F3"), "social worker note presence never sent");
  assert.equal(headers[0]["x-tenant-id"], "tn_gaon");
  assert.equal(headers[0]["x-request-id"], "trc_contract_001");
  // contract: X-Request-Id is 8–64 of [A-Za-z0-9_.:-] — also for the ids the job queue generates (trc_<jobId>_<attempt>)
  const RID = /^[A-Za-z0-9_.:-]{8,64}$/;
  const { newId } = await import("../../lib/server/db/ids");
  for (let i = 0; i < 200; i++) assert.match(`trc_${newId("aij")}_${(i % 5) + 1}`, RID);
  const generated = await composeDraft({ provider: null, tenantId: "tn_gaon", kind: "referral_summary", facts: FACTS, ruleDraft: RULE, dataClass: "synthetic" });
  assert.match(generated.traceId, RID);
  assert.match(headers[0].authorization, /^Bearer /);
  // Gov's own schema is at least as strict as the contract on the shared limits
  assert.equal(summarizeRequestSchema.safeParse({ ...(bodies[0] as object), extra: 1 }).success, false);
  assert.equal(summarizeRequestSchema.safeParse({ ...(bodies[0] as object), allow_free_text: true }).success, false);
});

test("validator sanity: a request that breaks the contract is detected", () => {
  assert.ok(validate(S.SummarizeIn, { data_class: "synthetic", task_kind: "referral_summary", sections: [], records: [] }).length > 0);
  assert.ok(validate(S.SummarizeIn, { data_class: "synthetic", task_kind: "x", sections: ["a"], records: [{ id: "bad id!", text: "t" }], surprise: true }).length >= 2);
});

test("every prototype error code / no-result reason is handled deliberately and none can steer retries", () => {
  for (const c of [...codes.error_codes, ...codes.no_result_reasons]) assert.ok(KNOWN_PROVIDER_CODES.has(c), `unknown prototype code ${c}`);
  for (const c of [...codes.error_codes, ...codes.no_result_reasons, ...codes.llm_adapter_reasons]) {
    const stored = providerSuppliedCode(c);
    assert.ok(!RETRYABLE.has(stored) && !DEFERRABLE.has(stored), `${c} → ${stored} would change job control flow`);
  }
  assert.equal(providerSuppliedCode("unavailable"), "llm_unavailable");
  assert.equal(providerSuppliedCode("error"), "provider_error");
});
