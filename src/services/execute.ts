import { createHash } from "node:crypto";
import { canonicalJson, MutationSchema, type Mutation } from "../domain/contracts";
import type { GitHubReadClient } from "../adapters/github-read";
import { GitHubWriteError, type GitHubCommentResult, type GitHubIssueResult, type GitHubWriteClient } from "../adapters/github-write-standalone.mts";

export type ExecutionErrorCode =
  | "execution_invalid_request"
  | "execution_not_found"
  | "execution_payload_mismatch"
  | "execution_stale"
  | "execution_target_unavailable"
  | "execution_persistence_failed";

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

export interface ApprovedProposal {
  tenantId: string;
  proposalId: string;
  operationId: string;
  version: number;
  payloadHash: string;
  expiresAt: Date;
  state: "APPROVED";
  mutation: Mutation;
}

export interface ExecutionDependencies {
  now: () => Date;
  loadApprovedProposal: (input: { tenantId: string; operationId: string }) => Promise<ApprovedProposal | null>;
  claimMutation: (input: { tenantId: string; operationId: string; attemptId: string; leaseExpiresAt: Date }) => Promise<{ fencingToken: number } | null>;
  github: GitHubWriteClient;
  githubRead?: Pick<GitHubReadClient, "getIssue">;
  recordSuccess: (input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; externalId: string; externalUrl?: string; externalIssueNumber?: number; actualAssignees?: string[]; assigneeMismatch?: boolean }) => Promise<{ jobId: string } | null>;
  recordFailure: (input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }) => Promise<void>;
  recordUnknown: (input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }) => Promise<void>;
  recordStale: (input: { tenantId: string; operationId: string; errorCode: string }) => Promise<void>;
}

export type ExecutionState = "SUCCEEDED" | "FAILED" | "UNKNOWN" | "IN_PROGRESS" | "STALE" | "BLOCKED";

export interface ExecutionResult {
  state: ExecutionState;
  leaseExpiresAt: Date;
  externalId?: string;
  externalUrl?: string;
  actualAssignees?: string[];
  assigneeMismatch?: boolean;
  jobId?: string;
}

function ensureId(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new ExecutionError("execution_invalid_request", `${label} is required`);
}

function assertExternalIdentity(result: GitHubIssueResult | GitHubCommentResult, mutation: Mutation, issueNumber: number): void {
  const id = Number(result.id);
  const issueUrl = `https://github.com/${mutation.owner}/${mutation.repo}/issues/${issueNumber}`;
  const expectedUrl = mutation.kind === "CREATE_ISSUE" ? issueUrl : `${issueUrl}#issuecomment-${result.id}`;
  if (typeof result.id !== "string" || !Number.isSafeInteger(id) || id < 1 || String(id) !== result.id || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || result.url !== expectedUrl) throw new Error("github_identity_unknown");
}

function validateProposal(proposal: ApprovedProposal, input: { tenantId: string; operationId: string }, now: Date): Mutation {
  if (proposal.tenantId !== input.tenantId || proposal.operationId !== input.operationId) throw new ExecutionError("execution_not_found", "approved operation is unavailable");
  if (proposal.state !== "APPROVED" || !(proposal.expiresAt instanceof Date) || !Number.isFinite(proposal.expiresAt.getTime()) || !Number.isFinite(now.getTime()) || proposal.expiresAt.getTime() <= now.getTime()) throw new ExecutionError("execution_stale", "approved operation is stale");
  let mutation: Mutation;
  try {
    mutation = MutationSchema.parse(proposal.mutation);
  } catch {
    throw new ExecutionError("execution_payload_mismatch", "persisted mutation is invalid");
  }
  const expectedHash = createHash("sha256").update(canonicalJson({ schemaVersion: 1, tenantId: proposal.tenantId, operationId: proposal.operationId, version: proposal.version, mutation: proposal.mutation }), "utf8").digest("hex");
  const markers = mutation.body.match(/<!--\s*signal-operation:[\s\S]*?-->/gi);
  if (!Number.isSafeInteger(proposal.version) || proposal.version < 1 || expectedHash !== proposal.payloadHash || canonicalJson(proposal.mutation) !== canonicalJson(mutation) || markers?.length !== 1 || markers[0] !== `<!-- signal-operation:${proposal.operationId} -->`) throw new ExecutionError("execution_payload_mismatch", "persisted payload hash or operation marker does not match");
  return mutation;
}

async function recheckTarget(mutation: Mutation, dependencies: ExecutionDependencies): Promise<void> {
  if (mutation.kind !== "ADD_PROGRESS_COMMENT") return;
  if (!dependencies.githubRead) throw new ExecutionError("execution_target_unavailable", "target read adapter is unavailable");
  try {
    const target = await dependencies.githubRead.getIssue({ owner: mutation.owner, repo: mutation.repo, issueNumber: mutation.issueNumber });
    if (target.id !== mutation.issueId || target.number !== mutation.issueNumber || target.state !== "open" || target.isPullRequest || target.htmlUrl !== `https://github.com/${mutation.owner}/${mutation.repo}/issues/${mutation.issueNumber}`) {
      throw new ExecutionError("execution_stale", "comment target is no longer eligible");
    }
  } catch (error: unknown) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_target_unavailable", "comment target could not be revalidated");
  }
}

export async function executeApprovedProposal(
  input: { tenantId: string; operationId: string; attemptId: string; leaseDurationMs?: number },
  dependencies: ExecutionDependencies,
): Promise<ExecutionResult> {
  ensureId(input.tenantId, "tenantId");
  ensureId(input.operationId, "operationId");
  ensureId(input.attemptId, "attemptId");
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) throw new ExecutionError("execution_invalid_request", "mutation lease is invalid");
  const proposal = await dependencies.loadApprovedProposal({ tenantId: input.tenantId, operationId: input.operationId });
  if (!proposal) throw new ExecutionError("execution_not_found", "approved operation is unavailable");
  const mutation = validateProposal(proposal, input, dependencies.now());
  try {
    await recheckTarget(mutation, dependencies);
  } catch (error: unknown) {
    const code = error instanceof ExecutionError ? error.code : "execution_target_unavailable";
    if (code === "execution_stale") {
      await dependencies.recordStale({ tenantId: input.tenantId, operationId: input.operationId, errorCode: code });
      return { state: "STALE", leaseExpiresAt: dependencies.now() };
    }
    return { state: "BLOCKED", leaseExpiresAt: dependencies.now() };
  }
  // Reads can consume the approval window. Recheck immutable material before claiming.
  validateProposal(proposal, input, dependencies.now());
  const leaseExpiresAt = new Date(dependencies.now().getTime() + leaseDurationMs);
  if (!Number.isFinite(leaseExpiresAt.getTime())) throw new ExecutionError("execution_invalid_request", "mutation lease is invalid");
  const claim = await dependencies.claimMutation({ tenantId: input.tenantId, operationId: input.operationId, attemptId: input.attemptId, leaseExpiresAt });
  if (!claim) return { state: "IN_PROGRESS", leaseExpiresAt };
  if (!Number.isSafeInteger(claim.fencingToken) || claim.fencingToken < 1) throw new ExecutionError("execution_persistence_failed", "mutation fencing authority is invalid");
  let result: GitHubIssueResult | GitHubCommentResult;
  let actualAssignees: string[] | undefined;
  let assigneeMismatch: boolean | undefined;
  let returnedIssueNumber: number;
  try {
    const remainingMs = leaseExpiresAt.getTime() - dependencies.now().getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 || proposal.expiresAt.getTime() <= dependencies.now().getTime()) {
      throw new GitHubWriteError("invalid_input", "mutation deadline elapsed before sending", { outcome: "definite_rejection" });
    }
    const signal = AbortSignal.timeout(Math.min(30_000, remainingMs));
    if (mutation.kind === "CREATE_ISSUE") {
      const issueResult = await dependencies.github.createIssue({ owner: mutation.owner, repo: mutation.repo, title: mutation.title, body: mutation.body, assignees: mutation.assignees, signal });
      result = issueResult;
      if (!Array.isArray(issueResult.assignees) || issueResult.assignees.some((login) => typeof login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login))) throw new Error("github_identity_unknown");
      actualAssignees = [...issueResult.assignees];
      assigneeMismatch = actualAssignees.length !== mutation.assignees.length || actualAssignees.some((login, index) => login.toLowerCase() !== mutation.assignees[index]?.toLowerCase());
      returnedIssueNumber = issueResult.number;
    } else {
      result = await dependencies.github.addProgressComment({ owner: mutation.owner, repo: mutation.repo, issueNumber: mutation.issueNumber, body: mutation.body, signal });
      returnedIssueNumber = mutation.issueNumber;
    }
    signal.throwIfAborted();
    assertExternalIdentity(result, mutation, returnedIssueNumber);
  } catch (error: unknown) {
    const unknown = error instanceof GitHubWriteError ? error.outcome !== "definite_rejection" : true;
    try {
      if (unknown) {
        await dependencies.recordUnknown({ tenantId: input.tenantId, operationId: input.operationId, attemptId: input.attemptId, fencingToken: claim.fencingToken, errorCode: error instanceof GitHubWriteError ? error.code : "github_unknown" });
        return { state: "UNKNOWN", leaseExpiresAt };
      }
      await dependencies.recordFailure({ tenantId: input.tenantId, operationId: input.operationId, attemptId: input.attemptId, fencingToken: claim.fencingToken, errorCode: error instanceof GitHubWriteError ? error.code : "github_rejected" });
      return { state: "FAILED", leaseExpiresAt };
    } catch {
      throw new ExecutionError("execution_persistence_failed", "mutation outcome could not be recorded");
    }
  }
  // A local error after the POST cannot establish non-creation. Preserve the fence
  // for recovery, including when the success transaction committed but its reply was lost.
  try {
    const persisted = await dependencies.recordSuccess({ tenantId: input.tenantId, operationId: input.operationId, attemptId: input.attemptId, fencingToken: claim.fencingToken, externalId: result.id, externalUrl: result.url, externalIssueNumber: returnedIssueNumber, actualAssignees, assigneeMismatch });
    if (!persisted) throw new Error("fence_lost");
    return { state: "SUCCEEDED", leaseExpiresAt, externalId: result.id, externalUrl: result.url, actualAssignees, assigneeMismatch, jobId: persisted.jobId };
  } catch {
    throw new ExecutionError("execution_persistence_failed", "successful mutation result could not be recorded");
  }
}
