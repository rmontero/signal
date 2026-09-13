import { ApprovalBindingSchema, type ApprovalBinding } from "../domain/contracts";
import {
  ApprovalError,
  renderApprovalModal,
  type ApprovalModal,
  type ApprovalNoticeModal,
  type ApprovalRequest,
  type DismissProposalRequest,
  type PrepareReviewRequest,
  type PreparedProposalReview,
} from "./approve";

const MAX_BODY_BYTES = 64 * 1024;
const SLACK_ID = /^[A-Z][A-Z0-9_-]{1,127}$/;
const PROPOSAL_ACTION = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([1-9][0-9]*)$/;
const PrivateMetadataSchema = ApprovalBindingSchema.omit({ actorSlackId: true });

export interface SlackInteractionResponse {
  status: 200 | 400 | 413 | 500;
  body: { ok: true } | { ok: false; error: string } | { response_action: "errors"; errors: Record<string, string> }
    | { response_action: "update"; view: ApprovalNoticeModal } | { response_action: "clear" };
}

export interface SlackInteractionDependencies {
  resolveTenantId: (input: { slackTeamId: string }) => Promise<string | null>;
  prepareReview: (input: PrepareReviewRequest) => Promise<PreparedProposalReview>;
  openModal: (input: { triggerId: string; modal: ApprovalModal }) => Promise<{ viewId: string }>;
  openNotice?: (input: { triggerId: string; modal: ApprovalNoticeModal }) => Promise<void>;
  recordReview: (input: PreparedProposalReview, modalId: string) => Promise<void>;
  dismissReview: (input: DismissProposalRequest) => Promise<void>;
  submitApproval: (input: ApprovalRequest) => Promise<{ approvalId: string; jobId: string }>;
}

type UnknownRecord = Record<string, unknown>;

class InteractionValidationError extends Error {}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new InteractionValidationError(`${label}_invalid`);
  return value;
}

function slackId(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SLACK_ID.test(parsed)) throw new InteractionValidationError(`${label}_invalid`);
  return parsed;
}

function getRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new InteractionValidationError(`${label}_invalid`);
  return value;
}

function getTeamId(payload: UnknownRecord): string {
  const team = isRecord(payload.team) ? payload.team.id : undefined;
  const teamId = slackId(team, "slack_team_id");
  if (isRecord(payload.user) && "team_id" in payload.user && slackId(payload.user.team_id, "slack_user_team_id") !== teamId) {
    throw new InteractionValidationError("approval_context_invalid");
  }
  return teamId;
}

function getChannelId(payload: UnknownRecord): string {
  const channel = "channel" in payload ? slackId(getRecord(payload.channel, "channel").id, "slack_channel_id") : undefined;
  const container = "container" in payload ? slackId(getRecord(payload.container, "container").channel_id, "slack_channel_id") : undefined;
  if (channel !== undefined && container !== undefined && channel !== container) throw new InteractionValidationError("approval_context_invalid");
  return slackId(channel ?? container, "slack_channel_id");
}

function getUserId(payload: UnknownRecord): string {
  const user = getRecord(payload.user, "slack_user");
  if (("is_bot" in user && user.is_bot !== false) || "bot_id" in user) throw new InteractionValidationError("slack_user_invalid");
  return slackId(user.id, "slack_user_id");
}

function getTenantId(teamId: string, dependencies: SlackInteractionDependencies): Promise<string> {
  return dependencies.resolveTenantId({ slackTeamId: teamId }).then((tenantId) => {
    if (!tenantId) throw new InteractionValidationError("tenant_unavailable");
    return text(tenantId, "tenant_id");
  });
}

function getAction(payload: UnknownRecord): { actionId: string; proposalId: string; version: number } {
  if (!Array.isArray(payload.actions) || payload.actions.length !== 1) throw new InteractionValidationError("action_invalid");
  const action = getRecord(payload.actions[0], "action");
  const actionId = text(action.action_id, "action_id");
  const value = text(action.value, "action_value");
  const match = PROPOSAL_ACTION.exec(value);
  if (!match) throw new InteractionValidationError("action_value_invalid");
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) throw new InteractionValidationError("action_value_invalid");
  return { actionId, proposalId: match[1], version };
}

function parsePrivateMetadata(value: unknown): Omit<ApprovalBinding, "actorSlackId"> {
  let metadata: unknown;
  try {
    metadata = JSON.parse(text(value, "private_metadata", 4_096));
  } catch {
    throw new InteractionValidationError("private_metadata_invalid");
  }
  if (!isRecord(metadata)) throw new InteractionValidationError("private_metadata_invalid");
  try {
    const binding = PrivateMetadataSchema.parse(metadata);
    if (!Number.isSafeInteger(binding.version)) throw new Error("invalid version");
    for (const [key, value] of Object.entries(binding)) {
      if (metadata[key] !== value) throw new Error("noncanonical identity");
      if (typeof value === "string") text(value, "private_metadata_field");
    }
    slackId(binding.slackTeamId, "slack_team_id");
    slackId(binding.channelId, "slack_channel_id");
    return binding;
  } catch {
    throw new InteractionValidationError("private_metadata_invalid");
  }
}

function badRequest(error = "interaction_invalid"): SlackInteractionResponse {
  return { status: 400, body: { ok: false, error } };
}

function unavailable(): SlackInteractionResponse {
  return { status: 500, body: { ok: false, error: "interaction_unavailable" } };
}

function approvalNotice(error: ApprovalError): ApprovalNoticeModal {
  const message = error.code === "approval_persistence_failed"
    ? "Approval could not be confirmed. Close this notice and review the proposal again."
    : "This proposal is not available for this action. Return to the Slack thread to review the current proposal.";
  return {
    type: "modal",
    title: { type: "plain_text", text: "Proposal unavailable" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: message } }],
  };
}

async function businessError(error: ApprovalError, payload: UnknownRecord, dependencies: SlackInteractionDependencies): Promise<SlackInteractionResponse> {
  const modal = approvalNotice(error);
  if (payload.type === "view_submission") {
    // This read-only view has no input block to attach response_action:errors to.
    return { status: 200, body: { response_action: "update", view: modal } };
  }
  if (error.code === "approval_persistence_failed") return unavailable();
  if (dependencies.openNotice && payload.trigger_id !== undefined) {
    try {
      await dependencies.openNotice({ triggerId: text(payload.trigger_id, "trigger_id"), modal });
    } catch {
      return unavailable();
    }
  }
  return { status: 200, body: { ok: false, error: error.code } };
}

async function handleBlockAction(payload: UnknownRecord, dependencies: SlackInteractionDependencies): Promise<SlackInteractionResponse> {
  const { actionId, proposalId, version } = getAction(payload);
  const actorSlackId = getUserId(payload);
  const slackTeamId = getTeamId(payload);
  const channelId = getChannelId(payload);
  const tenantId = await getTenantId(slackTeamId, dependencies);
  const request = { tenantId, proposalId, slackTeamId, channelId, actorSlackId };
  if (actionId === "signal.review_proposal") {
    const triggerId = text(payload.trigger_id, "trigger_id");
    const prepared = await dependencies.prepareReview(request);
    const metadata = parsePrivateMetadata(prepared.result.privateMetadata);
    if (prepared.result.proposalId !== proposalId || prepared.result.version !== version || prepared.review.version !== version
      || Object.entries(request).some(([key, value]) => prepared.review[key as keyof PrepareReviewRequest] !== value)
      || metadata.tenantId !== tenantId || metadata.proposalId !== proposalId || metadata.slackTeamId !== slackTeamId
      || metadata.channelId !== channelId || metadata.version !== version || metadata.expiresAt !== prepared.result.expiresAt) {
      throw new InteractionValidationError("review_binding_invalid");
    }
    const opened = await dependencies.openModal({ triggerId, modal: renderApprovalModal(prepared.result) });
    const viewId = text(opened.viewId, "view_id");
    try {
      await dependencies.recordReview(prepared, viewId);
    } catch {
      // The trigger was consumed by views.open. An unrecorded modal never authorizes submission.
      return unavailable();
    }
    return { status: 200, body: { ok: true } };
  }
  if (actionId === "signal.dismiss_proposal") {
    await dependencies.dismissReview({ ...request, version });
    return { status: 200, body: { ok: true } };
  }
  throw new InteractionValidationError("action_unknown");
}

async function handleViewSubmission(payload: UnknownRecord, dependencies: SlackInteractionDependencies): Promise<SlackInteractionResponse> {
  const view = getRecord(payload.view, "view");
  if (view.callback_id !== "signal.approve_proposal") throw new InteractionValidationError("callback_unknown");
  const modalId = text(view.id, "view_id");
  const actorSlackId = getUserId(payload);
  const slackTeamId = getTeamId(payload);
  const binding = parsePrivateMetadata(view.private_metadata);
  if (binding.slackTeamId !== slackTeamId) throw new InteractionValidationError("approval_context_invalid");
  const channelId = binding.channelId;
  if (("channel" in payload || (isRecord(payload.container) && "channel_id" in payload.container)) && getChannelId(payload) !== channelId) {
    throw new InteractionValidationError("approval_context_invalid");
  }
  const tenantId = await getTenantId(slackTeamId, dependencies);
  if (binding.tenantId !== tenantId) throw new InteractionValidationError("approval_context_invalid");
  const request: ApprovalRequest = { ...binding, tenantId, channelId, actorSlackId, modalId };
  await dependencies.submitApproval(request);
  return { status: 200, body: { response_action: "clear" } };
}

// The HTTP ingress must verify Slack's raw-body signature/timestamp before calling this parser.
export async function handleSlackInteraction(rawBody: string, dependencies: SlackInteractionDependencies): Promise<SlackInteractionResponse> {
  if (typeof rawBody !== "string" || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: "interaction_too_large" } };
  let payload: unknown;
  try {
    const encoded = new URLSearchParams(rawBody).getAll("payload");
    if (encoded.length === 0 || !encoded[0]) return badRequest("payload_missing");
    if (encoded.length !== 1) return badRequest("payload_invalid");
    payload = JSON.parse(encoded[0]);
  } catch {
    return badRequest("payload_invalid");
  }
  try {
    const record = getRecord(payload, "payload");
    if (record.type === "block_actions") return await handleBlockAction(record, dependencies);
    if (record.type === "view_submission") return await handleViewSubmission(record, dependencies);
    return badRequest("interaction_type_unknown");
  } catch (error: unknown) {
    if (error instanceof ApprovalError && isRecord(payload)) return businessError(error, payload, dependencies);
    if (error instanceof InteractionValidationError) return badRequest(error.message);
    return unavailable();
  }
}
