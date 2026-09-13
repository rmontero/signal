import { z } from "zod";
import { AnalysisSchema } from "../domain/contracts";

const MAX_FACTS = 20;
const MAX_FACT_TEXT = 1_000;
const MAX_EVIDENCE = 5;
// Reserve the application-owned UUID marker before accepting the model draft.
const MAX_DRAFT_BODY = 6_000 - "\n<!-- signal-operation:00000000-0000-0000-0000-000000000000 -->".length;
const factText = z.string().trim().min(1).max(MAX_FACT_TEXT);
const evidence = AnalysisSchema.shape.decisions.element.shape.evidence.min(1).max(MAX_EVIDENCE);
const boundedAnalysis = AnalysisSchema.extend({
  decisions: z.array(AnalysisSchema.shape.decisions.element.extend({ text: factText, evidence })).max(MAX_FACTS),
  tasks: z.array(AnalysisSchema.shape.tasks.element.extend({
    text: factText, evidence,
    ownerSlackId: z.string().trim().min(1).max(80).nullable(),
    deadlineText: z.string().trim().min(1).max(200).nullable(),
  })).max(MAX_FACTS),
  blockers: z.array(AnalysisSchema.shape.blockers.element.extend({ text: factText, evidence })).max(MAX_FACTS),
  uncertainties: z.array(factText).max(MAX_FACTS),
});

export const FactExtractionSchema = z.object({
  analysis: boundedAnalysis,
  searchQueries: z.array(z.string().trim().min(1).max(200)).max(2),
}).strict();
export type FactExtraction = z.infer<typeof FactExtractionSchema>;

export const MutationDraftSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().trim().min(1).max(MAX_DRAFT_BODY),
  assigneeSlackId: z.string().trim().min(1).max(80).nullable(),
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
      maxItems: MAX_FACTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", minLength: 1, maxLength: MAX_FACT_TEXT }, evidence: { type: "array", minItems: 1, maxItems: MAX_EVIDENCE, items: evidenceJsonSchema } },
        required: ["text", "evidence"],
      },
    },
    tasks: {
      type: "array",
      maxItems: MAX_FACTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: MAX_FACT_TEXT },
          ownerSlackId: { type: ["string", "null"], minLength: 1, maxLength: 80 },
          deadlineText: { type: ["string", "null"], minLength: 1, maxLength: 200 },
          evidence: { type: "array", minItems: 1, maxItems: MAX_EVIDENCE, items: evidenceJsonSchema },
        },
        required: ["text", "ownerSlackId", "deadlineText", "evidence"],
      },
    },
    blockers: {
      type: "array",
      maxItems: MAX_FACTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", minLength: 1, maxLength: MAX_FACT_TEXT }, evidence: { type: "array", minItems: 1, maxItems: MAX_EVIDENCE, items: evidenceJsonSchema } },
        required: ["text", "evidence"],
      },
    },
    uncertainties: { type: "array", maxItems: MAX_FACTS, items: { type: "string", minLength: 1, maxLength: MAX_FACT_TEXT } },
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
    body: { type: "string", minLength: 1, maxLength: MAX_DRAFT_BODY },
    assigneeSlackId: { type: ["string", "null"], minLength: 1, maxLength: 80 },
    relatedCandidateIds: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 } },
  },
  required: ["title", "body", "assigneeSlackId", "relatedCandidateIds"],
} as const;
