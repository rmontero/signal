import { MutationSchema, payloadHash, type Mutation } from "../domain/contracts";
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
  recordSuccess: (input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; externalId: string; externalUrl?: string; externalIssueNumber?: number; actualAssignees?: string[] }) => Promise<{ jobId: string } | null>;
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
  jobId?: string;
}

function ensureId(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new ExecutionError("execution_invalid_request", `${label} is required`);
}

function assertExternalIdentity(urlValue: string, mutation: Mutation, issueNumber: number): void {
  try {
    const url = new URL(urlValue);
    const path = url.pathname.split("/").filter(Boolean);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || path.length !== 4 || path[0] !== mutation.owner || path[1] !== mutation.repo || path[2] !== "issues" || path[3] !== String(issueNumber)) throw new Error("out of scope");
  } catch {
    throw new Error("github_identity_unknown");
  }
}

function validateProposal(proposal: ApprovedProposal, input: { tenantId: string; operationId: string }, now: Date): Mutation {
  if (proposal.tenantId !== input.tenantId || proposal.operationId !== input.operationId) throw new ExecutionError("execution_not_found", "approved operation is unavailable");
  if (proposal.state !== "APPROVED" || proposal.expiresAt.getTime() <= now.getTime()) throw new ExecutionError("execution_stale", "approved operation is stale");
  let mutation: Mutation;
  try {
    mutation = MutationSchema.parse(proposal.mutation);
  } catch {
    throw new ExecutionError("execution_payload_mismatch", "persisted mutation is invalid");
  }
  const expectedHash = payloadHash({ schemaVersion: 1, tenantId: proposal.tenantId, operationId: proposal.operationId, version: proposal.version, mutation });
  if (expectedHash !== proposal.payloadHash) throw new ExecutionError("execution_payload_mismatch", "persisted payload hash does not match");
  return mutation;
}

async function recheckTarget(mutation: Mutation, dependencies: ExecutionDependencies): Promise<void> {
  if (mutation.kind !== "ADD_PROGRESS_COMMENT") return;
  if (!dependencies.githubRead) throw new ExecutionError("execution_target_unavailable", "target read adapter is unavailable");
  try {
    const target = await dependencies.githubRead.getIssue({ owner: mutation.owner, repo: mutation.repo, issueNumber: mutation.issueNumber });
    if (target.id !== mutation.issueId || target.number !== mutation.issueNumber || target.state !== "open" || target.isPullRequest) {
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
  const leaseExpiresAt = new Date(dependencies.now().getTime() + (input.leaseDurationMs ?? 60_000));
  const claim = await dependencies.claimMutation({ tenantId: input.tenantId, operationId: input.operationId, attemptId: input.attemptId, leaseExpiresAt });
  if (!claim) return { state: "IN_PROGRESS", leaseExpiresAt };
  try {
    let result: GitHubIssueResult | GitHubCommentResult;
    let actualAssignees: string[] | undefined;
    let returnedIssueNumber: number;
    if (mutation.kind === "CREATE_ISSUE") {
      const issueResult = await dependencies.github.createIssue({ owner: mutation.owner, repo: mutation.repo, title: mutation.title, body: mutation.body, assignees: mutation.assignees });
      result = issueResult;
      actualAssignees = issueResult.assignees;
      returnedIssueNumber = issueResult.number;
    } else {
      result = await dependencies.github.addProgressComment({ owner: mutation.owner, repo: mutation.repo, issueNumber: mutation.issueNumber, body: mutation.body });
      returnedIssueNumber = mutation.issueNumber;
    }
    assertExternalIdentity(result.url, mutation, returnedIssueNumber);
    const persisted = await dependencies.recordSuccess({ tenantId: input.tenantId, operationId: input.operationId, attemptId: input.attemptId, fencingToken: claim.fencingToken, externalId: result.id, externalUrl: result.url, externalIssueNumber: returnedIssueNumber, actualAssignees });
    if (!persisted) throw new ExecutionError("execution_persistence_failed", "successful mutation result lost its fencing authority");
    return { state: "SUCCEEDED", leaseExpiresAt, externalId: result.id, externalUrl: result.url, actualAssignees, jobId: persisted.jobId };
  } catch (error: unknown) {
    if (error instanceof ExecutionError) throw error;
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
}
