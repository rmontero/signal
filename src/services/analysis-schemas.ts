import { z } from "zod";
import { AnalysisSchema } from "../domain/contracts";

export const FactExtractionSchema = z.object({
  analysis: AnalysisSchema,
  searchQueries: z.array(z.string().trim().min(1).max(200)).max(2),
}).strict();
export type FactExtraction = z.infer<typeof FactExtractionSchema>;

export const MutationDraftSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().trim().min(1).max(6_000),
  assigneeSlackId: z.string().trim().min(1).nullable(),
  relatedCandidateIds: z.array(z.string().trim().min(1)).max(5),
}).strict();
export type MutationDraft = z.infer<typeof MutationDraftSchema>;

const evidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    messageTs: { type: "string", minLength: 1 },
    permalink: { type: "string", format: "uri" },
  },
  required: ["messageTs", "permalink"],
} as const;

const analysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", minLength: 1 }, evidence: { type: "array", items: evidenceJsonSchema } },
        required: ["text", "evidence"],
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1 },
          ownerSlackId: { type: ["string", "null"] },
          deadlineText: { type: ["string", "null"] },
          evidence: { type: "array", items: evidenceJsonSchema },
        },
        required: ["text", "ownerSlackId", "deadlineText", "evidence"],
      },
    },
    blockers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", minLength: 1 }, evidence: { type: "array", items: evidenceJsonSchema } },
        required: ["text", "evidence"],
      },
    },
    uncertainties: { type: "array", items: { type: "string", minLength: 1 } },
  },
  required: ["decisions", "tasks", "blockers", "uncertainties"],
} as const;

export const FACT_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    analysis: analysisJsonSchema,
    searchQueries: { type: "array", maxItems: 2, items: { type: "string", minLength: 1, maxLength: 200 } },
  },
  required: ["analysis", "searchQueries"],
} as const;

export const MUTATION_DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 256 },
    body: { type: "string", minLength: 1, maxLength: 6_000 },
    assigneeSlackId: { type: ["string", "null"] },
    relatedCandidateIds: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 } },
  },
  required: ["title", "body", "assigneeSlackId", "relatedCandidateIds"],
} as const;
