/**
 * Neulgyeot AI Intelligence API contract v1.1 — request/response schemas as seen from Gov.
 * Source of truth: KREWX/02_Platform/Neulgyeot-AI-Integration-Design/prototype/contract/openapi.v1.1.json.
 * Gov validates every response with these schemas; anything unexpected is treated as "no AI result".
 */
import { z } from "zod";

export const CONTRACT_MAJOR = "1.";
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

export const summarizeRequestSchema = z.object({
  data_class: z.literal("synthetic"), // real data is refused by the service; Gov never sends anything else in this phase
  task_kind: z.enum(["referral_summary", "social_opinion", "meeting_brief"]),
  sections: z.array(z.string().min(1).max(80)).min(1).max(8),
  records: z.array(z.object({ id, text: z.string().min(1).max(1000), kind: z.literal("structured") })).min(1).max(60),
  allow_free_text: z.literal(false),
}).strict();
export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>;

export const summarizeResponseSchema = z.object({
  request_id: z.string().regex(/^req_[0-9a-f]{20}$/),
  trace_id: z.string().max(64),
  status: z.enum(["ok", "no_result"]),
  reason: z.string().max(60).nullable(),
  engine: z.string().max(120),
  model: z.string().max(160).nullable(),
  prompt_version: z.string().max(80),
  contract_version: z.string().max(40).optional(),
  sections: z.array(z.object({
    title: z.string().max(80),
    sentences: z.array(z.object({ text: z.string().min(2).max(400), source_ids: z.array(z.string().max(64)).max(16) })).max(12),
  })).max(8),
  requires_human_review: z.literal(true),
}).passthrough();
export type SummarizeResponse = z.infer<typeof summarizeResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.string(),
  contract_version: z.string(),
  engine: z.string(),
  llm_available: z.boolean(),
  data_policy: z.literal("synthetic_only"),
  external_llm: z.literal("blocked"),
}).passthrough();

export const predictResponseSchema = z.object({
  request_id: z.string(),
  model_id: z.string(),
  model_version: z.string(),
  score: z.number().min(0).max(1),
  band: z.enum(["low", "moderate", "high"]),
  use: z.literal("research_only"), // anything else is rejected: predictions never drive admin decisions or alerts
}).passthrough();

export const errorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), trace_id: z.string().nullable().optional() }) });
