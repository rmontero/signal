import { createHash } from "node:crypto";
import { canonicalJson, MutationSchema, type Mutation, type OperationState } from "../domain/contracts";
import type { GitHubReconciliationRecord } from "../adapters/github-read";

export type ReconciliationRecord = GitHubReconciliationRecord & { assignees?: string[] };

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
  | { state: "SUCCEEDED"; externalId: string; externalUrl: string; jobId: string; actualAssignees?: string[]; assigneeMismatch?: boolean }
  | { state: "UNKNOWN"; reason: "active_attempt" | "not_found" | "ambiguous" | "incomplete" | "unavailable" };

export interface ReconciliationDependencies {
  now: () => Date;
  loadOperation: (input: { tenantId: string; operationId: string }) => Promise<UnknownOperation | null>;
  isOwningAttemptTerminal: (input: { tenantId: string; operationId: string; attemptId: string }) => Promise<boolean>;
  transitionSendingToUnknown: (input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; errorCode: string }) => Promise<boolean>;
  getRepository: (input: { tenantId: string; owner: string; repo: string }) => Promise<{ id: string; owner: string; repo: string } | null>;
  listIssues: (input: { owner: string; repo: string }) => Promise<ReconciliationRecord[]>;
  listComments: (input: { owner: string; repo: string; issueNumber: number }) => Promise<ReconciliationRecord[]>;
  recordSuccess: (input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; externalId: string; externalUrl: string; externalIssueNumber?: number; actualAssignees?: string[]; assigneeMismatch?: boolean }) => Promise<{ jobId: string } | null>;
  recordUnresolved: (input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; errorCode: string; resolutionNote: string }) => Promise<void>;
}

function marker(operationId: string): string {
  return `<!-- signal-operation:${operationId} -->`;
}

function validExternalId(id: string): boolean {
  return typeof id === "string" && Number.isSafeInteger(Number(id)) && Number(id) > 0 && String(Number(id)) === id;
}

function exactIssueMatch(record: ReconciliationRecord, mutation: Extract<Mutation, { kind: "CREATE_ISSUE" }>, operationId: string, author: string): boolean {
  return validExternalId(record.id) && Number.isSafeInteger(record.issueNumber) && record.issueNumber! > 0 && record.body === mutation.body && record.title === mutation.title && record.authorLogin === author && record.url === `https://github.com/${mutation.owner}/${mutation.repo}/issues/${record.issueNumber}` && record.body.includes(marker(operationId));
}

function exactCommentMatch(record: ReconciliationRecord, mutation: Extract<Mutation, { kind: "ADD_PROGRESS_COMMENT" }>, operationId: string, author: string): boolean {
  return validExternalId(record.id) && record.body === mutation.body && record.authorLogin === author && record.issueId === mutation.issueId && record.issueNumber === mutation.issueNumber && record.url === `https://github.com/${mutation.owner}/${mutation.repo}/issues/${mutation.issueNumber}#issuecomment-${record.id}` && record.body.includes(marker(operationId));
}

function operationIsUsable(operation: UnknownOperation, now: Date): "ready" | "active" | "incomplete" {
  if (!["UNKNOWN", "SENDING"].includes(operation.state) || typeof operation.ownerAttemptId !== "string" || !operation.ownerAttemptId.trim() || !(operation.leaseExpiresAt instanceof Date) || !Number.isFinite(operation.leaseExpiresAt.getTime()) || !(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(operation.fencingToken) || operation.fencingToken < 1) return "incomplete";
  return operation.leaseExpiresAt.getTime() > now.getTime() ? "active" : "ready";
}

function immutablePayloadMatches(operation: UnknownOperation): boolean {
  try {
    if (!Number.isSafeInteger(operation.version) || operation.version < 1 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$/.test(operation.expectedAuthorLogin)) return false;
    const parsed = MutationSchema.parse(operation.mutation);
    const markers = parsed.body.match(/<!--\s*signal-operation:[\s\S]*?-->/gi);
    if (markers?.length !== 1 || markers[0] !== marker(operation.operationId) || canonicalJson(parsed) !== canonicalJson(operation.mutation)) return false;
    const hash = createHash("sha256").update(canonicalJson({ schemaVersion: 1, tenantId: operation.tenantId, operationId: operation.operationId, version: operation.version, mutation: operation.mutation }), "utf8").digest("hex");
    return hash === operation.payloadHash;
  } catch { return false; }
}

/** Resolve an uncertain write by read-back only. This function never calls a GitHub POST. */
export async function reconcileUnknownOperation(
  input: { tenantId: string; operationId: string },
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationResult> {
  if (typeof input.tenantId !== "string" || !input.tenantId.trim() || typeof input.operationId !== "string" || !input.operationId.trim()) return { state: "UNKNOWN", reason: "incomplete" };
  let operation: UnknownOperation | null;
  try { operation = await dependencies.loadOperation(input); } catch { throw new Error("reconciliation_load_failed"); }
  if (!operation || operation.tenantId !== input.tenantId || operation.operationId !== input.operationId) return { state: "UNKNOWN", reason: "incomplete" };
  if (!immutablePayloadMatches(operation)) return { state: "UNKNOWN", reason: "incomplete" };

  const readiness = operationIsUsable(operation, dependencies.now());
  if (readiness === "incomplete") return { state: "UNKNOWN", reason: "incomplete" };
  let canRecordNote = operation.state === "UNKNOWN";
  const note = async (errorCode: string, resolutionNote: string) => {
    if (!canRecordNote) return;
    try {
      await dependencies.recordUnresolved({ ...input, ownerAttemptId: operation.ownerAttemptId!, fencingToken: operation.fencingToken, errorCode, resolutionNote });
    } catch { throw new Error("reconciliation_persistence_failed"); }
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
    let transitioned: boolean;
    try {
      transitioned = await dependencies.transitionSendingToUnknown({ tenantId: input.tenantId, operationId: input.operationId, ownerAttemptId: operation.ownerAttemptId!, fencingToken: operation.fencingToken, errorCode: "github_unknown" });
    } catch { throw new Error("reconciliation_persistence_failed"); }
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
  const validAssignees = match.assignees === undefined || (Array.isArray(match.assignees) && match.assignees.every((login) => typeof login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)));
  if (candidates.length > 1 || !exact || !validAssignees) {
    await note("reconcile_ambiguous_marker", "Multiple or mismatched operation markers were found; operator review is required.");
    return { state: "UNKNOWN", reason: "ambiguous" };
  }

  const assignment: { actualAssignees?: string[]; assigneeMismatch?: boolean } = {};
  if (operation.mutation.kind === "CREATE_ISSUE" && match.assignees !== undefined) {
    const requested = operation.mutation.assignees;
    assignment.actualAssignees = [...match.assignees];
    assignment.assigneeMismatch = match.assignees.length !== requested.length || match.assignees.some((login, index) => login.toLowerCase() !== requested[index]?.toLowerCase());
  }
  let result: { jobId: string } | null;
  try {
    result = await dependencies.recordSuccess({ tenantId: input.tenantId, operationId: input.operationId, ownerAttemptId: operation.ownerAttemptId!, fencingToken: operation.fencingToken, externalId: match.id, externalUrl: match.url, ...(operation.mutation.kind === "CREATE_ISSUE" ? { externalIssueNumber: match.issueNumber } : {}), ...assignment });
  } catch { throw new Error("reconciliation_persistence_failed"); }
  if (!result) return { state: "UNKNOWN", reason: "incomplete" };
  return { state: "SUCCEEDED", externalId: match.id, externalUrl: match.url, jobId: result.jobId, ...assignment };
}
