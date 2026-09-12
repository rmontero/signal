import { createHash, randomUUID } from "node:crypto";
import {
  actionFingerprint,
  canonicalJson,
  MutationSchema,
  payloadHash,
  prepareMutation,
  type Analysis,
  type Mutation,
} from "../domain/contracts";
import { GitHubReadError, type GitHubCandidate, type GitHubReadClient } from "../adapters/github-read";
import { OpenRouterError, type OpenRouterStructuredClient } from "../adapters/openrouter";
import {
  FACT_EXTRACTION_JSON_SCHEMA,
  FactExtractionSchema,
  MUTATION_DRAFT_JSON_SCHEMA,
  MutationDraftSchema,
  type FactExtraction,
  type MutationDraft,
} from "./analysis-schemas";

const MAX_MESSAGES = 50;
const PROPOSAL_TTL_MS = 30 * 60 * 1_000;
export const ANALYSIS_PROMPT_VERSION = "signal-analysis-prompt-v1";
export const ANALYSIS_SCHEMA_VERSION = 1 as const;

export type AnalysisErrorCode =
  | "analysis_invalid_context"
  | "analysis_no_action"
  | "analysis_target_invalid"
  | "analysis_provider_unavailable"
  | "analysis_model_invalid"
  | "analysis_persistence_failed";

export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;

  constructor(code: AnalysisErrorCode, message: string) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
  }
}

export interface SourceMessage {
  ts: string;
  user: string | null;
  text: string;
  permalink: string;
  editedAt?: string | null;
  isBot?: boolean;
}

export interface AnalysisContext {
  tenantId: string;
  threadId: string;
  channelId: string;
  threadTs: string;
  version: number;
  invocationText: string;
  repository: { repoId: string; owner: string; repo: string };
  sourceMessages: SourceMessage[];
  linkedIssue?: { id: string; number: number };
  identityMappings: Record<string, string>;
  now?: Date;
}

export interface PersistedProposal {
  proposalId: string;
  operationId: string;
  payloadHash: string;
}

export interface ProposalPersistenceInput {
  tenantId: string;
  threadId: string;
  version: number;
  snapshot: { content: SourceMessage[]; snapshotHash: string; expiresAt: Date };
  analysis: Analysis;
  mutation: Mutation;
  operationId: string;
  actionFingerprint: string;
  payloadHash: string;
  expiresAt: Date;
  metadata: { modelVersion: string; promptVersion: string; schemaVersion: typeof ANALYSIS_SCHEMA_VERSION };
}

export interface AnalysisDependencies {
  model: OpenRouterStructuredClient;
  github: GitHubReadClient;
  persistProposal: (input: ProposalPersistenceInput) => Promise<PersistedProposal>;
}

export interface AnalyzeResult {
  analysis: Analysis;
  candidates: GitHubCandidate[];
  mutation: Mutation;
  snapshotHash: string;
  actionFingerprint: string;
  operationId: string;
  payloadHash: string;
  persisted: PersistedProposal;
  metadata: { modelVersion: string; promptVersion: string; schemaVersion: typeof ANALYSIS_SCHEMA_VERSION };
}

function invalid(message: string): AnalysisError {
  return new AnalysisError("analysis_invalid_context", message);
}

function assertId(value: string, label: string): void {
  if (!value.trim()) throw invalid(`${label} is required`);
}

function validateContext(context: AnalysisContext): void {
  assertId(context.tenantId, "tenantId");
  assertId(context.threadId, "threadId");
  assertId(context.channelId, "channelId");
  assertId(context.threadTs, "threadTs");
  assertId(context.repository.repoId, "repository id");
  assertId(context.repository.owner, "repository owner");
  assertId(context.repository.repo, "repository name");
  if (!Number.isInteger(context.version) || context.version <= 0) throw invalid("version is invalid");
  if (context.sourceMessages.length === 0 || context.sourceMessages.length > MAX_MESSAGES) throw invalid("source context must contain one to fifty messages");
  const timestamps = new Set<string>();
  for (const message of context.sourceMessages) {
    assertId(message.ts, "message timestamp");
    if (timestamps.has(message.ts)) throw invalid("source context contains duplicate message timestamps");
    timestamps.add(message.ts);
    if (!message.text.trim() || message.isBot) throw invalid("source context contains an invalid or bot message");
    try {
      const url = new URL(message.permalink);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    } catch {
      throw invalid("source context contains an invalid permalink");
    }
  }
}

function sourceSnapshotHash(messages: SourceMessage[]): string {
  return createHash("sha256").update(canonicalJson(messages.map(({ ts, user, text, permalink, editedAt = null }) => ({ ts, user, text, permalink, editedAt }))), "utf8").digest("hex");
}

function promptMessages(messages: SourceMessage[]): string {
  return messages.map((message) => `[${message.ts}] ${message.user ?? "unknown"}: ${message.text}\nSource: ${message.permalink}`).join("\n");
}

function factPrompt(context: AnalysisContext): string {
  return JSON.stringify({
    task: "Extract decisions, tasks, blockers, uncertainties, and up to two repository-scoped search queries from this Slack thread.",
    repository: context.repository,
    messages: promptMessages(context.sourceMessages),
    rules: ["Use only the supplied messages as evidence.", "Do not invent users, issues, repositories, URLs, or deadlines.", "Search queries are terms only; the server scopes them to the configured repository."],
  });
}

function draftPrompt(context: AnalysisContext, facts: FactExtraction, candidates: GitHubCandidate[], target: GitHubCandidate | undefined): string {
  return JSON.stringify({
    task: "Draft one deterministic GitHub action from validated facts.",
    repository: context.repository,
    invocation: context.invocationText,
    facts,
    candidates,
    explicitTarget: target ?? null,
    rules: [
      "Write a concise title and body grounded in the facts.",
      "Include only supplied Slack or GitHub URLs in the body.",
      "Choose assigneeSlackId only from task owners present in the facts; otherwise null.",
      "relatedCandidateIds must contain only supplied candidate ids.",
      "The server, not the model, chooses whether this is a new issue or a comment.",
    ],
  });
}

async function completeModel(
  model: AnalysisDependencies["model"],
  input: Parameters<AnalysisDependencies["model"]["complete"]>[0],
): Promise<unknown> {
  try {
    return await model.complete(input);
  } catch (error: unknown) {
    if (error instanceof AnalysisError) throw error;
    if (error instanceof OpenRouterError && error.code === "openrouter_invalid_output") {
      throw new AnalysisError("analysis_model_invalid", "model returned invalid structured output");
    }
    throw new AnalysisError("analysis_provider_unavailable", "model provider is unavailable");
  }
}

function validateAnalysisEvidence(analysis: Analysis, messages: SourceMessage[]): Analysis {
  const sourceByTs = new Map(messages.map((message) => [message.ts, message.permalink]));
  const evidenceIsValid = (messageTs: string, permalink: string): boolean => sourceByTs.get(messageTs) === permalink;
  for (const decision of analysis.decisions) {
    if (decision.evidence.length === 0) throw new AnalysisError("analysis_model_invalid", "actionable model fact has no evidence");
    if (decision.evidence.some((evidence) => !evidenceIsValid(evidence.messageTs, evidence.permalink))) throw new AnalysisError("analysis_model_invalid", "model evidence is not grounded in the source snapshot");
  }
  for (const task of analysis.tasks) {
    if (task.evidence.length === 0) throw new AnalysisError("analysis_model_invalid", "actionable model fact has no evidence");
    if (task.evidence.some((evidence) => !evidenceIsValid(evidence.messageTs, evidence.permalink))) throw new AnalysisError("analysis_model_invalid", "model evidence is not grounded in the source snapshot");
  }
  for (const blocker of analysis.blockers) {
    if (blocker.evidence.length === 0) throw new AnalysisError("analysis_model_invalid", "actionable model fact has no evidence");
    if (blocker.evidence.some((evidence) => !evidenceIsValid(evidence.messageTs, evidence.permalink))) throw new AnalysisError("analysis_model_invalid", "model evidence is not grounded in the source snapshot");
  }
  return analysis;
}

function normalizeOwners(analysis: Analysis, identityMappings: Record<string, string>): Analysis {
  const uncertainties = [...analysis.uncertainties];
  const tasks = analysis.tasks.map((task) => {
    if (task.ownerSlackId && !identityMappings[task.ownerSlackId]) {
      uncertainties.push(`No GitHub identity mapping for Slack user ${task.ownerSlackId}`);
      return { ...task, ownerSlackId: null };
    }
    return task;
  });
  return { ...analysis, tasks, uncertainties: [...new Set(uncertainties)] };
}

function explicitTargetNumbers(context: AnalysisContext): number[] {
  const numbers = new Set<number>();
  const hasTargetAction = /\b(?:update|actualiza|comment|comenta)\b/i.test(context.invocationText);
  const actionPattern = hasTargetAction ? /#(\d+)/g : /(?:update|actualiza|comment|comenta)\s+#(\d+)/gi;
  for (const match of context.invocationText.matchAll(actionPattern)) numbers.add(Number(match[1]));
  const anyGitHubUrl = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/gi;
  for (const match of context.invocationText.matchAll(anyGitHubUrl)) {
    if (match[1] !== context.repository.owner || match[2] !== context.repository.repo) {
      throw new AnalysisError("analysis_target_invalid", "invocation target is outside the configured repository");
    }
    numbers.add(Number(match[3]));
  }
  return [...numbers].filter((number) => Number.isInteger(number) && number > 0);
}

async function resolveTarget(context: AnalysisContext, github: GitHubReadClient): Promise<GitHubCandidate | undefined> {
  const numbers = explicitTargetNumbers(context);
  if (numbers.length > 1) throw new AnalysisError("analysis_target_invalid", "invocation contains multiple explicit GitHub targets");
  const issueNumber = numbers[0] ?? context.linkedIssue?.number;
  if (!issueNumber) return undefined;
  try {
    const target = await github.getIssue({ owner: context.repository.owner, repo: context.repository.repo, issueNumber });
    if (target.state !== "open" || target.isPullRequest) throw new AnalysisError("analysis_target_invalid", "target is not an open issue");
    return target;
  } catch (error: unknown) {
    if (error instanceof AnalysisError) throw error;
    if (error instanceof GitHubReadError) throw new AnalysisError("analysis_provider_unavailable", "GitHub target lookup failed");
    throw new AnalysisError("analysis_provider_unavailable", "GitHub target lookup failed");
  }
}

function validateDraftLinks(body: string, messages: SourceMessage[], candidates: GitHubCandidate[]): void {
  const allowed = new Set([...messages.map((message) => message.permalink), ...candidates.map((candidate) => candidate.htmlUrl)]);
  const urls = body.match(/https?:\/\/[^\s)\]>]+/g) ?? [];
  if (urls.some((url) => !allowed.has(url.replace(/[.,;:!?]+$/, "")))) throw new AnalysisError("analysis_model_invalid", "draft contains an unsupported URL");
}

function mapAssignee(draft: MutationDraft, analysis: Analysis, mappings: Record<string, string>): string | undefined {
  if (!draft.assigneeSlackId) return undefined;
  const login = mappings[draft.assigneeSlackId];
  if (!login) {
    analysis.uncertainties.push(`Assignee has no GitHub identity mapping for Slack user ${draft.assigneeSlackId}`);
    return undefined;
  }
  return login;
}

export async function analyzeThread(context: AnalysisContext, dependencies: AnalysisDependencies): Promise<AnalyzeResult> {
  validateContext(context);
  const snapshotHash = sourceSnapshotHash(context.sourceMessages);
  const factsValue = await completeModel(dependencies.model, {
    system: "You are Signal's read-only fact extraction step. Return only the requested strict JSON object.",
    user: factPrompt(context),
    schemaName: "signal_fact_extraction",
    schema: FACT_EXTRACTION_JSON_SCHEMA,
  });
  let facts: FactExtraction;
  try {
    facts = FactExtractionSchema.parse(factsValue);
    validateAnalysisEvidence(facts.analysis, context.sourceMessages);
  } catch (error: unknown) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError("analysis_model_invalid", "model fact extraction failed validation");
  }
  const analysis = normalizeOwners(facts.analysis, context.identityMappings);
  if (analysis.decisions.length === 0 && analysis.tasks.length === 0 && analysis.blockers.length === 0) {
    throw new AnalysisError("analysis_no_action", "source context does not contain an actionable decision, task, or blocker");
  }
  let candidates: GitHubCandidate[] = [];
  if (facts.searchQueries.length > 0) {
    try {
      candidates = await dependencies.github.search({ owner: context.repository.owner, repo: context.repository.repo, queries: facts.searchQueries });
    } catch (error: unknown) {
      if (error instanceof GitHubReadError) throw new AnalysisError("analysis_provider_unavailable", "GitHub search failed");
      throw new AnalysisError("analysis_provider_unavailable", "GitHub search failed");
    }
  }
  const target = await resolveTarget(context, dependencies.github);
  const allCandidates = target && !candidates.some((candidate) => candidate.id === target.id) ? [...candidates, target] : candidates;
  const draftValue = await completeModel(dependencies.model, {
    system: "You are Signal's read-only mutation drafting step. Return only the requested strict JSON object.",
    user: draftPrompt(context, { ...facts, analysis }, allCandidates, target),
    schemaName: "signal_mutation_draft",
    schema: MUTATION_DRAFT_JSON_SCHEMA,
  });
  let draft: MutationDraft;
  try {
    draft = MutationDraftSchema.parse(draftValue);
  } catch {
    throw new AnalysisError("analysis_model_invalid", "model mutation draft failed validation");
  }
  const candidateIds = new Set(allCandidates.map((candidate) => candidate.id));
  if (draft.relatedCandidateIds.some((id) => !candidateIds.has(id))) throw new AnalysisError("analysis_model_invalid", "draft references an unknown GitHub candidate");
  validateDraftLinks(draft.body, context.sourceMessages, allCandidates);
  const assignee = mapAssignee(draft, analysis, context.identityMappings);
  const mutationInput: Mutation = target
    ? { kind: "ADD_PROGRESS_COMMENT", repoId: context.repository.repoId, owner: context.repository.owner, repo: context.repository.repo, issueId: target.id, issueNumber: target.number, body: draft.body }
    : { kind: "CREATE_ISSUE", repoId: context.repository.repoId, owner: context.repository.owner, repo: context.repository.repo, title: draft.title, body: draft.body, assignees: assignee ? [assignee] : [] };
  const operationId = randomUUID();
  let mutation: Mutation;
  try {
    mutation = MutationSchema.parse(prepareMutation(mutationInput, operationId));
  } catch {
    throw new AnalysisError("analysis_model_invalid", "draft cannot be represented as an allowed mutation");
  }
  const destination = target ? { repoId: context.repository.repoId, issueId: target.id, issueNumber: target.number } : { repoId: context.repository.repoId };
  const fingerprint = actionFingerprint({ tenantId: context.tenantId, channelId: context.channelId, threadTs: context.threadTs, snapshotHash, kind: mutation.kind, destination });
  const computedPayloadHash = payloadHash({ schemaVersion: 1, tenantId: context.tenantId, operationId, version: context.version, mutation });
  const now = context.now ?? new Date();
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS);
  const metadata = {
    modelVersion: dependencies.model.modelVersion ?? "unknown",
    promptVersion: ANALYSIS_PROMPT_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
  };
  let persisted: PersistedProposal;
  try {
    persisted = await dependencies.persistProposal({
      tenantId: context.tenantId,
      threadId: context.threadId,
      version: context.version,
      snapshot: { content: context.sourceMessages, snapshotHash, expiresAt },
      analysis,
      mutation,
      operationId,
      actionFingerprint: fingerprint,
      payloadHash: computedPayloadHash,
      expiresAt,
      metadata,
    });
  } catch {
    throw new AnalysisError("analysis_persistence_failed", "proposal persistence failed");
  }
  return { analysis, candidates: allCandidates, mutation, snapshotHash, actionFingerprint: fingerprint, operationId, payloadHash: computedPayloadHash, persisted, metadata };
}
