import { createHash } from "node:crypto";
import { ApprovalBindingSchema, canonicalJson, MutationSchema, type ApprovalBinding, type Mutation } from "../domain/contracts";

export type ApprovalErrorCode =
  | "approval_invalid_request"
  | "approval_not_found"
  | "approval_unauthorized"
  | "approval_stale"
  | "approval_persistence_failed";

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

export interface ApprovalProposal {
  tenantId: string;
  proposalId: string;
  operationId: string;
  version: number;
  payloadHash: string;
  expiresAt: Date;
  state: "PENDING" | "APPROVED" | "DISMISSED" | "SUPERSEDED" | "EXPIRED";
  slackTeamId: string;
  channelId: string;
  mutation: Mutation;
}

export interface ProposalReview {
  tenantId: string;
  proposalId: string;
  modalId: string;
  actorSlackId: string;
  slackTeamId: string;
  channelId: string;
  version: number;
}

export interface ReviewRequest {
  tenantId: string;
  proposalId: string;
  slackTeamId: string;
  channelId: string;
  actorSlackId: string;
  modalId: string;
}

export type PrepareReviewRequest = Omit<ReviewRequest, "modalId">;

export interface DismissProposalRequest extends PrepareReviewRequest {
  version: number;
}

export interface PreparedProposalReview {
  result: ReviewResult;
  review: Omit<ProposalReview, "modalId">;
}

export interface ApprovalRequest extends ApprovalBinding {
  modalId: string;
}

export interface ApprovalDependencies {
  now: () => Date;
  loadProposal: (input: { tenantId: string; proposalId: string }) => Promise<ApprovalProposal | null>;
  recordReview: (input: ProposalReview) => Promise<void>;
  loadReview: (input: { tenantId: string; proposalId: string; modalId: string }) => Promise<ProposalReview | null>;
  isNamedApprover: (input: { tenantId: string; channelId: string; slackUserId: string }) => Promise<boolean>;
  // Persistence must atomically recheck this modal and return the original result on exact replay.
  approve: (binding: ApprovalRequest) => Promise<{ approvalId: string; jobId: string }>;
  dismiss: (input: { tenantId: string; proposalId: string; version: number; slackTeamId: string; channelId: string; actorSlackId: string }) => Promise<void>;
}

export interface ReviewResult {
  proposalId: string;
  version: number;
  mutation: Mutation;
  expiresAt: string;
  privateMetadata: string;
}

export interface ApprovalModal {
  type: "modal";
  callback_id: "signal.approve_proposal";
  private_metadata: string;
  title: { type: "plain_text"; text: string };
  submit: { type: "plain_text"; text: string };
  close: { type: "plain_text"; text: string };
  blocks: Array<{ type: "section"; text: { type: "mrkdwn"; text: string } } | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }>;
}

export type ApprovalNoticeModal = Pick<ApprovalModal, "type" | "title" | "close" | "blocks">;

function requireId(value: string, label: string): void {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApprovalError("approval_invalid_request", `${label} is invalid`);
  }
}

function proposalIsUsable(proposal: ApprovalProposal, now: Date, allowReplay = false): void {
  if (proposal.state !== "PENDING" && !(allowReplay && proposal.state === "APPROVED")) {
    throw new ApprovalError("approval_stale", "proposal is no longer pending");
  }
  if (!(proposal.expiresAt instanceof Date) || !Number.isFinite(proposal.expiresAt.getTime()) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ApprovalError("approval_stale", "proposal expiry is invalid");
  }
  // An expired pending proposal cannot be approved. A replay only retrieves an existing result.
  if (proposal.state === "PENDING" && proposal.expiresAt.getTime() <= now.getTime()) {
    throw new ApprovalError("approval_stale", "proposal has expired");
  }
  try {
    for (const key of ["tenantId", "proposalId", "operationId", "slackTeamId", "channelId"] as const) requireId(proposal[key], key);
    if (!Number.isSafeInteger(proposal.version) || proposal.version < 1) throw new Error("invalid version");
    const validated = MutationSchema.parse(proposal.mutation);
    if (canonicalJson(validated) !== canonicalJson(proposal.mutation)) throw new Error("noncanonical mutation");
    // Hash the persisted bytes. The drafting helper prepares/normalizes mutations and is unsafe here.
    const hash = createHash("sha256").update(canonicalJson({
      schemaVersion: 1, tenantId: proposal.tenantId, operationId: proposal.operationId,
      version: proposal.version, mutation: proposal.mutation,
    }), "utf8").digest("hex");
    if (hash !== proposal.payloadHash) throw new Error("hash mismatch");
  } catch {
    throw new ApprovalError("approval_stale", "proposal payload is invalid");
  }
}

async function requireNamedApprover(input: PrepareReviewRequest, dependencies: ApprovalDependencies): Promise<void> {
  let authorized: boolean;
  try {
    authorized = await dependencies.isNamedApprover({ tenantId: input.tenantId, channelId: input.channelId, slackUserId: input.actorSlackId });
  } catch {
    throw new ApprovalError("approval_persistence_failed", "approver policy could not be checked");
  }
  if (authorized !== true) throw new ApprovalError("approval_unauthorized", "actor is not a named approver");
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function withoutOperationMarker(value: string): string {
  return value.replace(/\s*<!--\s*signal-operation:[^>]*-->/gi, "").trim();
}

function splitForSlack(value: string, limit: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += limit) chunks.push(value.slice(offset, offset + limit));
  return chunks.length > 0 ? chunks : [""];
}

export function renderApprovalModal(review: ReviewResult): ApprovalModal {
  const body = escapeMrkdwn(withoutOperationMarker(review.mutation.body));
  const destination = review.mutation.kind === "CREATE_ISSUE"
    ? `Create issue in ${review.mutation.owner}/${review.mutation.repo}`
    : `Comment on ${review.mutation.owner}/${review.mutation.repo}#${review.mutation.issueNumber}`;
  const blocks: ApprovalModal["blocks"] = [
    { type: "section", text: { type: "mrkdwn", text: `*Destination*\n${escapeMrkdwn(destination)}` } },
  ];
  if (review.mutation.kind === "CREATE_ISSUE") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Title*\n${escapeMrkdwn(review.mutation.title)}` } });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `*Assignee*\n${review.mutation.assignees[0] ? escapeMrkdwn(review.mutation.assignees[0]) : "Unassigned"}` }] });
  }
  for (const chunk of splitForSlack(body, 2_400)) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${review.mutation.kind === "CREATE_ISSUE" ? "Issue body" : "Comment"}*\n${chunk}` } });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Proposal version ${review.version} · expires ${escapeMrkdwn(review.expiresAt)}` }] });
  return {
    type: "modal",
    callback_id: "signal.approve_proposal",
    private_metadata: review.privateMetadata,
    title: { type: "plain_text", text: "Review Signal proposal" },
    submit: { type: "plain_text", text: "Approve" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

async function loadScopedProposal(
  input: { tenantId: string; proposalId: string },
  dependencies: ApprovalDependencies,
  allowReplay = false,
): Promise<ApprovalProposal> {
  requireId(input.tenantId, "tenantId");
  requireId(input.proposalId, "proposalId");
  let proposal: ApprovalProposal | null;
  try {
    proposal = await dependencies.loadProposal(input);
  } catch {
    throw new ApprovalError("approval_persistence_failed", "proposal could not be loaded");
  }
  if (!proposal || proposal.tenantId !== input.tenantId || proposal.proposalId !== input.proposalId) {
    throw new ApprovalError("approval_not_found", "proposal is unavailable");
  }
  proposalIsUsable(proposal, dependencies.now(), allowReplay);
  return proposal;
}

export async function prepareProposalReview(input: PrepareReviewRequest, dependencies: ApprovalDependencies): Promise<PreparedProposalReview> {
  requireId(input.slackTeamId, "slackTeamId");
  requireId(input.channelId, "channelId");
  requireId(input.actorSlackId, "actorSlackId");
  const proposal = await loadScopedProposal({ tenantId: input.tenantId, proposalId: input.proposalId }, dependencies);
  if (proposal.slackTeamId !== input.slackTeamId || proposal.channelId !== input.channelId) {
    throw new ApprovalError("approval_not_found", "proposal is unavailable");
  }
  await requireNamedApprover(input, dependencies);
  proposalIsUsable(proposal, dependencies.now());
  return {
    result: {
      proposalId: proposal.proposalId,
      version: proposal.version,
      mutation: proposal.mutation,
      expiresAt: proposal.expiresAt.toISOString(),
      privateMetadata: JSON.stringify({ tenantId: proposal.tenantId, proposalId: proposal.proposalId, operationId: proposal.operationId, version: proposal.version, payloadHash: proposal.payloadHash, expiresAt: proposal.expiresAt.toISOString(), slackTeamId: proposal.slackTeamId, channelId: proposal.channelId }),
    },
    review: {
      tenantId: proposal.tenantId,
      proposalId: proposal.proposalId,
      actorSlackId: input.actorSlackId,
      slackTeamId: input.slackTeamId,
      channelId: input.channelId,
      version: proposal.version,
    },
  };
}

export async function recordProposalReview(prepared: PreparedProposalReview, modalId: string, dependencies: ApprovalDependencies): Promise<void> {
  requireId(modalId, "modalId");
  // Slack allocates the ID after opening the modal; state or policy may have changed meanwhile.
  const current = await prepareProposalReview(prepared.review, dependencies);
  if (canonicalJson(prepared.review) !== canonicalJson(current.review) || canonicalJson(prepared.result) !== canonicalJson(current.result)) {
    throw new ApprovalError("approval_stale", "review no longer matches the persisted proposal");
  }
  try {
    await dependencies.recordReview({ ...prepared.review, modalId });
  } catch {
    throw new ApprovalError("approval_persistence_failed", "review state could not be recorded");
  }
}

export async function openProposalReview(input: ReviewRequest, dependencies: ApprovalDependencies): Promise<ReviewResult> {
  requireId(input.modalId, "modalId");
  const prepared = await prepareProposalReview(input, dependencies);
  await recordProposalReview(prepared, input.modalId, dependencies);
  return prepared.result;
}

export async function submitProposalApproval(input: ApprovalRequest, dependencies: ApprovalDependencies): Promise<{ approvalId: string; jobId: string }> {
  requireId(input.modalId, "modalId");
  let binding: ApprovalBinding;
  try {
    for (const key of ["tenantId", "proposalId", "operationId", "slackTeamId", "channelId", "actorSlackId"] as const) requireId(input[key], key);
    if (!Number.isSafeInteger(input.version)) throw new Error("invalid version");
    const bindingInput = {
      tenantId: input.tenantId,
      proposalId: input.proposalId,
      operationId: input.operationId,
      version: input.version,
      payloadHash: input.payloadHash,
      expiresAt: input.expiresAt,
      slackTeamId: input.slackTeamId,
      channelId: input.channelId,
      actorSlackId: input.actorSlackId,
    };
    const parsed = ApprovalBindingSchema.parse(bindingInput);
    binding = parsed;
  } catch {
    throw new ApprovalError("approval_invalid_request", "approval binding is invalid");
  }
  let review: ProposalReview | null;
  try {
    review = await dependencies.loadReview({ tenantId: binding.tenantId, proposalId: binding.proposalId, modalId: input.modalId });
  } catch {
    throw new ApprovalError("approval_persistence_failed", "review could not be loaded");
  }
  if (!review || review.tenantId !== binding.tenantId || review.proposalId !== binding.proposalId || review.modalId !== input.modalId || review.actorSlackId !== binding.actorSlackId || review.slackTeamId !== binding.slackTeamId || review.channelId !== binding.channelId || review.version !== binding.version) {
    throw new ApprovalError("approval_unauthorized", "approval context is not authorized");
  }
  const proposal = await loadScopedProposal({ tenantId: binding.tenantId, proposalId: binding.proposalId }, dependencies, true);
  if (proposal.operationId !== binding.operationId || proposal.version !== binding.version || proposal.payloadHash !== binding.payloadHash || proposal.slackTeamId !== binding.slackTeamId || proposal.channelId !== binding.channelId || proposal.expiresAt.toISOString() !== binding.expiresAt) {
    throw new ApprovalError("approval_stale", "approval binding does not match the persisted proposal");
  }
  await requireNamedApprover(binding, dependencies);
  proposalIsUsable(proposal, dependencies.now(), true);
  try {
    return await dependencies.approve({ ...binding, modalId: input.modalId });
  } catch {
    throw new ApprovalError("approval_stale", "proposal could not be approved");
  }
}

export async function dismissProposal(input: DismissProposalRequest, dependencies: ApprovalDependencies): Promise<void> {
  requireId(input.slackTeamId, "slackTeamId");
  requireId(input.channelId, "channelId");
  requireId(input.actorSlackId, "actorSlackId");
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new ApprovalError("approval_invalid_request", "proposal version is invalid");
  const proposal = await loadScopedProposal({ tenantId: input.tenantId, proposalId: input.proposalId }, dependencies);
  if (proposal.slackTeamId !== input.slackTeamId || proposal.channelId !== input.channelId) throw new ApprovalError("approval_not_found", "proposal is unavailable");
  if (proposal.version !== input.version) throw new ApprovalError("approval_stale", "proposal version is stale");
  await requireNamedApprover(input, dependencies);
  proposalIsUsable(proposal, dependencies.now());
  try {
    await dependencies.dismiss({ tenantId: proposal.tenantId, proposalId: proposal.proposalId, version: proposal.version, slackTeamId: input.slackTeamId, channelId: input.channelId, actorSlackId: input.actorSlackId });
  } catch {
    throw new ApprovalError("approval_persistence_failed", "proposal could not be dismissed");
  }
}
