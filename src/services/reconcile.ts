import type { Mutation, OperationState } from "../domain/contracts";
import type { GitHubReconciliationRecord } from "../adapters/github-read";

export type ReconciliationRecord = GitHubReconciliationRecord;

export type UnknownOperation = {
  tenantId: string;
  operationId: string;
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
  transitionSendingToUnknown: (input: { tenantId: string; operationId: string; ownerAttemptId: string; errorCode: string }) => Promise<boolean>;
  listIssues: (input: { owner: string; repo: string }) => Promise<ReconciliationRecord[]>;
  listComments: (input: { owner: string; repo: string; issueNumber: number }) => Promise<ReconciliationRecord[]>;
  recordSuccess: (input: { tenantId: string; operationId: string; externalId: string; externalUrl: string }) => Promise<{ jobId: string } | null>;
  recordUnresolved: (input: { tenantId: string; operationId: string; errorCode: string; resolutionNote: string }) => Promise<void>;
}

function marker(operationId: string): string {
  return `<!-- signal-operation:${operationId} -->`;
}

function exactIssueMatch(record: ReconciliationRecord, mutation: Extract<Mutation, { kind: "CREATE_ISSUE" }>, operationId: string, author: string): boolean {
  return record.body === mutation.body && record.title === mutation.title && record.authorLogin === author && record.url === `https://github.com/${mutation.owner}/${mutation.repo}/issues/${record.issueNumber}` && record.body.includes(marker(operationId));
}

function exactCommentMatch(record: ReconciliationRecord, mutation: Extract<Mutation, { kind: "ADD_PROGRESS_COMMENT" }>, operationId: string, author: string): boolean {
  return record.body === mutation.body && record.authorLogin === author && record.issueId === mutation.issueId && record.issueNumber === mutation.issueNumber && record.body.includes(marker(operationId));
}

function operationIsUsable(operation: UnknownOperation, now: Date): "ready" | "active" | "incomplete" {
  if (operation.state === "UNKNOWN") return "ready";
  if (operation.state !== "SENDING" || !operation.ownerAttemptId || !operation.leaseExpiresAt) return "incomplete";
  return operation.leaseExpiresAt.getTime() > now.getTime() ? "active" : "ready";
}

/** Resolve an uncertain write by read-back only. This function never calls a GitHub POST. */
export async function reconcileUnknownOperation(
  input: { tenantId: string; operationId: string },
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationResult> {
  const operation = await dependencies.loadOperation(input);
  if (!operation || operation.tenantId !== input.tenantId) return { state: "UNKNOWN", reason: "incomplete" };

  const readiness = operationIsUsable(operation, dependencies.now());
  if (readiness === "active") {
    await dependencies.recordUnresolved({ tenantId: input.tenantId, operationId: input.operationId, errorCode: "reconcile_attempt_active", resolutionNote: "Owning attempt is still leased; reconciliation was not started." });
    return { state: "UNKNOWN", reason: "active_attempt" };
  }
  if (readiness === "incomplete") {
    await dependencies.recordUnresolved({ tenantId: input.tenantId, operationId: input.operationId, errorCode: "reconcile_not_eligible", resolutionNote: "Operation is not an eligible uncertain write." });
    return { state: "UNKNOWN", reason: "incomplete" };
  }

  if (operation.state === "SENDING") {
    if (!operation.ownerAttemptId || !(await dependencies.isOwningAttemptTerminal({ tenantId: input.tenantId, operationId: input.operationId, attemptId: operation.ownerAttemptId }))) {
      await dependencies.recordUnresolved({ tenantId: input.tenantId, operationId: input.operationId, errorCode: "reconcile_attempt_running", resolutionNote: "Owning attempt is not confirmed terminal; no read-back or mutation was attempted." });
      return { state: "UNKNOWN", reason: "active_attempt" };
    }
    const transitioned = await dependencies.transitionSendingToUnknown({ tenantId: input.tenantId, operationId: input.operationId, ownerAttemptId: operation.ownerAttemptId, errorCode: "github_unknown" });
    if (!transitioned) return { state: "UNKNOWN", reason: "active_attempt" };
  }

  let matches: ReconciliationRecord[];
  try {
    const mutation = operation.mutation;
    if (mutation.kind === "CREATE_ISSUE") {
      const records = await dependencies.listIssues({ owner: mutation.owner, repo: mutation.repo });
      matches = records.filter((record) => exactIssueMatch(record, mutation, operation.operationId, operation.expectedAuthorLogin));
    } else {
      const records = await dependencies.listComments({ owner: mutation.owner, repo: mutation.repo, issueNumber: mutation.issueNumber });
      matches = records.filter((record) => exactCommentMatch(record, mutation, operation.operationId, operation.expectedAuthorLogin));
    }
  } catch {
    await dependencies.recordUnresolved({ tenantId: input.tenantId, operationId: input.operationId, errorCode: "reconcile_read_failed", resolutionNote: "Provider read-back was incomplete or unavailable; absence is not evidence of non-creation." });
    return { state: "UNKNOWN", reason: "unavailable" };
  }

  if (matches.length === 0) {
    await dependencies.recordUnresolved({ tenantId: input.tenantId, operationId: input.operationId, errorCode: "reconcile_not_found", resolutionNote: "No exact operation marker was found; the operation remains UNKNOWN and must not be reposted." });
    return { state: "UNKNOWN", reason: "not_found" };
  }
  if (matches.length > 1) {
    await dependencies.recordUnresolved({ tenantId: input.tenantId, operationId: input.operationId, errorCode: "reconcile_multiple_matches", resolutionNote: "Multiple exact operation markers were found; operator review is required." });
    return { state: "UNKNOWN", reason: "ambiguous" };
  }

  const match = matches[0];
  const result = await dependencies.recordSuccess({ tenantId: input.tenantId, operationId: input.operationId, externalId: match.id, externalUrl: match.url });
  if (!result) return { state: "UNKNOWN", reason: "incomplete" };
  return { state: "SUCCEEDED", externalId: match.id, externalUrl: match.url, jobId: result.jobId };
}
