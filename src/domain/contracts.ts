import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

export const TenantContextSchema = z.object({ tenantId: id }).strict();
export type TenantContext = z.infer<typeof TenantContextSchema>;

export type PersistedConversationRow = {
  tenantId: string;
  threadId: string;
  channelId: string;
  threadTs: string;
  repositoryOwner: string;
  repositoryName: string;
  threadCreatedAt: Date;
  proposalId: string | null;
  proposalState: string | null;
  proposalVersion: number | null;
  proposalMutation: unknown;
  operationState: string | null;
  operationCreatedAt: Date | null;
};

export const TaskInputSchema = z.object({ tenantId: id, jobId: id, schemaVersion: z.literal(1) }).strict();
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const EvidenceSchema = z.object({ messageTs: id, permalink: z.string().url() }).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const AnalysisSchema = z.object({
  decisions: z.array(z.object({ text: id, evidence: z.array(EvidenceSchema) }).strict()),
  tasks: z.array(z.object({
    text: id,
    ownerSlackId: id.nullable(),
    deadlineText: z.string().trim().min(1).nullable(),
    evidence: z.array(EvidenceSchema),
  }).strict()),
  blockers: z.array(z.object({ text: id, evidence: z.array(EvidenceSchema) }).strict()),
  uncertainties: z.array(id),
}).strict();
export type Analysis = z.infer<typeof AnalysisSchema>;

const mutationBase = { repoId: id, owner: id, repo: id };

export const CreateIssueMutationSchema = z.object({
  kind: z.literal("CREATE_ISSUE"),
  ...mutationBase,
  title: z.string().trim().min(1).max(256),
  body: z.string().min(1).max(6_000),
  assignees: z.union([z.tuple([]), z.tuple([id])]),
}).strict();

export const AddProgressCommentMutationSchema = z.object({
  kind: z.literal("ADD_PROGRESS_COMMENT"),
  ...mutationBase,
  issueId: id,
  issueNumber: z.number().int().positive(),
  body: z.string().min(1).max(6_000),
}).strict();

export const MutationSchema = z.discriminatedUnion("kind", [CreateIssueMutationSchema, AddProgressCommentMutationSchema]);
export type Mutation = z.infer<typeof MutationSchema>;

export const ApprovalBindingSchema = z.object({
  tenantId: id,
  proposalId: id,
  operationId: id,
  version: z.number().int().positive(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: timestamp,
  slackTeamId: id,
  channelId: id,
  actorSlackId: id,
}).strict();
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

export const OperationStateSchema = z.enum(["READY", "SENDING", "SUCCEEDED", "FAILED", "UNKNOWN", "STALE"]);
export type OperationState = z.infer<typeof OperationStateSchema>;
export const ProposalStateSchema = z.enum(["PENDING", "APPROVED", "DISMISSED", "SUPERSEDED", "EXPIRED"]);
export type ProposalState = z.infer<typeof ProposalStateSchema>;
export const OutboxDispatchStateSchema = z.enum(["PENDING", "CLAIMED", "DISPATCHED"]);
export const OutboxExecutionStateSchema = z.enum(["READY", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED"]);
export type OutboxDispatchState = z.infer<typeof OutboxDispatchStateSchema>;
export type OutboxExecutionState = z.infer<typeof OutboxExecutionStateSchema>;

export const AcceptMentionSchema = z.object({
  tenantId: id,
  slackEventId: id,
  slackTeamId: id,
  channelId: id,
  threadTs: id,
  messageTs: id,
  actorSlackId: id,
}).strict();
export type AcceptMention = z.infer<typeof AcceptMentionSchema>;

export const ObserverEventSchema = z.object({
  tenantId: id,
  source: z.enum(["slack", "github"]),
  providerEventId: id,
  eventType: id,
  channelId: id.nullable(),
  threadTs: id.nullable(),
  messageTs: id.nullable(),
  actorId: id.nullable(),
  repositoryId: id.nullable(),
  repositoryOwner: id.nullable(),
  repositoryName: id.nullable(),
  installationId: id.nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ObserverEvent = z.infer<typeof ObserverEventSchema>;

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON does not permit non-finite numbers");
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function prepareMutation(mutationInput: Mutation, operationId: string): Mutation {
  const mutation = MutationSchema.parse(mutationInput);
  const body = normalizeLineEndings(mutation.body)
    .replace(/<!--\s*signal-operation:[^>]*-->/gi, "")
    .trimEnd();
  return MutationSchema.parse({ ...mutation, body: `${body}\n<!-- signal-operation:${id.parse(operationId)} -->` });
}

export function payloadHash(input: {
  schemaVersion: 1;
  tenantId: string;
  operationId: string;
  version: number;
  mutation: Mutation;
}): string {
  const mutation = prepareMutation(input.mutation, input.operationId);
  return createHash("sha256").update(canonicalJson({ ...input, mutation }), "utf8").digest("hex");
}

export function actionFingerprint(input: {
  tenantId: string;
  channelId: string;
  threadTs: string;
  snapshotHash: string;
  kind: Mutation["kind"];
  destination: { repoId: string; issueId?: string; issueNumber?: number };
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}
