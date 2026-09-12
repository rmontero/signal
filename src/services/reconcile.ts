import { payloadHash, type Mutation, type OperationState } from "../domain/contracts";
import type { GitHubReconciliationRecord } from "../adapters/github-read";

export type ReconciliationRecord = GitHubReconciliationRecord;

export type UnknownOperation = {
  tenantId: string;
  operationId: string;
  version: number;
  fencingToken: number;
  state: OperationState;
  leaseExpiresAt: Date | null;
  ownerAttemptId: string | null;
  mutation: Mutation;
  payloadHash: string;
  expectedAuthorLogin: string;
};

export type ReconciliationResult =
  | { state: "SUCCEEDED"; externalId: string; externalUrl: string; jobId: string }
  | { state: "UNKNOWN"; reason: "active_attempt" | "not_found" | "ambiguous" | "incomplete" | "unavailable" };

export interface ReconciliationDependencies {
  now: () => Date;
  loadOperation: (input: { tenantId: string; operationId: string }) => Promise<UnknownOperation | null>;
  isOwningAttemptTerminal: (input: { tenantId: string; operationId: string; attemptId: string }) => Promise<boolean>;
  transitionSendingToUnknown: (input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; errorCode: string }) => Promise<boolean>;
  getRepository: (input: { tenantId: string; owner: string; repo: string }) => Promise<{ id: string; owner: string; repo: string } | null>;
  listIssues: (input: { owner: string; repo: string }) => Promise<ReconciliationRecord[]>;
  listComments: (input: { owner: string; repo: string; issueNumber: number }) => Promise<ReconciliationRecord[]>;
  recordSuccess: (input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; externalId: string; externalUrl: string; externalIssueNumber?: number }) => Promise<{ jobId: string } | null>;
  recordUnresolved: (input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; errorCode: string; resolutionNote: string }) => Promise<void>;
}

function marker(operationId: string): string {
  return `<!-- signal-operation:${operationId} -->`;
}

function exactIssueMatch(record: ReconciliationRecord, mutation: Extract<Mutation, { kind: "CREATE_ISSUE" }>, operationId: string, author: string): boolean {
  return record.body === mutation.body && record.title === mutation.title && record.authorLogin === author && record.url === `https://github.com/${mutation.owner}/${mutation.repo}/issues/${record.issueNumber}` && record.body.includes(marker(operationId));
}

function exactCommentMatch(record: ReconciliationRecord, mutation: Extract<Mutation, { kind: "ADD_PROGRESS_COMMENT" }>, operationId: string, author: string): boolean {
  return record.body === mutation.body && record.authorLogin === author && record.issueId === mutation.issueId && record.issueNumber === mutation.issueNumber && record.url === `https://github.com/${mutation.owner}/${mutation.repo}/issues/${mutation.issueNumber}#issuecomment-${record.id}` && record.body.includes(marker(operationId));
}

function operationIsUsable(operation: UnknownOperation, now: Date): "ready" | "active" | "incomplete" {
  if (!["UNKNOWN", "SENDING"].includes(operation.state) || !operation.ownerAttemptId?.trim() || !operation.leaseExpiresAt || !Number.isFinite(operation.leaseExpiresAt.getTime()) || !Number.isSafeInteger(operation.fencingToken) || operation.fencingToken < 1) return "incomplete";
  return operation.leaseExpiresAt.getTime() > now.getTime() ? "active" : "ready";
}

/** Resolve an uncertain write by read-back only. This function never calls a GitHub POST. */
export async function reconcileUnknownOperation(
  input: { tenantId: string; operationId: string },
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationResult> {
  const operation = await dependencies.loadOperation(input);
  if (!operation || operation.tenantId !== input.tenantId || operation.operationId !== input.operationId) return { state: "UNKNOWN", reason: "incomplete" };
  if (payloadHash({ schemaVersion: 1, tenantId: operation.tenantId, operationId: operation.operationId, version: operation.version, mutation: operation.mutation }) !== operation.payloadHash) return { state: "UNKNOWN", reason: "incomplete" };

  const readiness = operationIsUsable(operation, dependencies.now());
  if (readiness === "incomplete") return { state: "UNKNOWN", reason: "incomplete" };
  let canRecordNote = operation.state === "UNKNOWN";
  const note = async (errorCode: string, resolutionNote: string) => {
    if (!canRecordNote) return;
    await dependencies.recordUnresolved({ ...input, ownerAttemptId: operation.ownerAttemptId!, fencingToken: operation.fencingToken, errorCode, resolutionNote });
  };
  if (readiness === "active") {
    await note("reconcile_attempt_active", "Owning attempt is still leased; reconciliation was not started.");
    return { state: "UNKNOWN", reason: "active_attempt" };
  }

  let ownerTerminal = false;
  try {
    ownerTerminal = await dependencies.isOwningAttemptTerminal({ tenantId: input.tenantId, operationId: input.operationId, attemptId: operation.ownerAttemptId! });
  } catch { /* Unavailable owner status is not evidence of terminality. */ }
  if (!ownerTerminal) {
    await note("reconcile_attempt_running", "Owning attempt is not confirmed terminal; no read-back or mutation was attempted.");
    return { state: "UNKNOWN", reason: "active_attempt" };
  }
  if (operation.state === "SENDING") {
    const transitioned = await dependencies.transitionSendingToUnknown({ tenantId: input.tenantId, operationId: input.operationId, ownerAttemptId: operation.ownerAttemptId!, fencingToken: operation.fencingToken, errorCode: "github_unknown" });
    if (!transitioned) return { state: "UNKNOWN", reason: "active_attempt" };
    canRecordNote = true;
  }

  let candidates: ReconciliationRecord[];
  try {
    const mutation = operation.mutation;
    const repository = await dependencies.getRepository({ tenantId: input.tenantId, owner: mutation.owner, repo: mutation.repo });
    if (!repository || repository.id !== mutation.repoId || repository.owner !== mutation.owner || repository.repo !== mutation.repo) {
      await note("reconcile_target_changed", "The configured repository identity changed; operator review is required.");
      return { state: "UNKNOWN", reason: "incomplete" };
    }
    if (mutation.kind === "CREATE_ISSUE") {
      const records = await dependencies.listIssues({ owner: mutation.owner, repo: mutation.repo });
      candidates = records.filter((record) => record.body.includes(marker(operation.operationId)));
    } else {
      const records = await dependencies.listComments({ owner: mutation.owner, repo: mutation.repo, issueNumber: mutation.issueNumber });
      candidates = records.filter((record) => record.body.includes(marker(operation.operationId)));
    }
  } catch {
    await note("reconcile_read_failed", "Provider read-back was incomplete or unavailable; absence is not evidence of non-creation.");
    return { state: "UNKNOWN", reason: "unavailable" };
  }

  if (candidates.length === 0) {
    await note("reconcile_not_found", "No exact operation marker was found; the operation remains UNKNOWN and must not be reposted.");
    return { state: "UNKNOWN", reason: "not_found" };
  }
  const match = candidates[0]!;
  const exact = operation.mutation.kind === "CREATE_ISSUE"
    ? exactIssueMatch(match, operation.mutation, operation.operationId, operation.expectedAuthorLogin)
    : exactCommentMatch(match, operation.mutation, operation.operationId, operation.expectedAuthorLogin);
  if (candidates.length > 1 || !exact) {
    await note("reconcile_ambiguous_marker", "Multiple or mismatched operation markers were found; operator review is required.");
    return { state: "UNKNOWN", reason: "ambiguous" };
  }

  const result = await dependencies.recordSuccess({ tenantId: input.tenantId, operationId: input.operationId, ownerAttemptId: operation.ownerAttemptId!, fencingToken: operation.fencingToken, externalId: match.id, externalUrl: match.url, ...(operation.mutation.kind === "CREATE_ISSUE" ? { externalIssueNumber: match.issueNumber } : {}) });
  if (!result) return { state: "UNKNOWN", reason: "incomplete" };
  return { state: "SUCCEEDED", externalId: match.id, externalUrl: match.url, jobId: result.jobId };
}
