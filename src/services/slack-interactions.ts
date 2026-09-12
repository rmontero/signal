import { ApprovalBindingSchema, type ApprovalBinding } from "../domain/contracts";
import {
  ApprovalError,
  renderApprovalModal,
  type ApprovalModal,
  type ApprovalRequest,
  type DismissProposalRequest,
  type PrepareReviewRequest,
  type PreparedProposalReview,
} from "./approve";

const MAX_BODY_BYTES = 64 * 1024;
const SLACK_ID = /^[A-Z][A-Z0-9_-]{1,127}$/;
const PROPOSAL_ACTION = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([1-9][0-9]*)$/;

export interface SlackInteractionResponse {
  status: 200 | 400 | 413 | 500;
  body: { ok: true } | { ok: false; error: string } | { response_action: "errors"; errors: Record<string, string> };
}

export interface SlackInteractionDependencies {
  resolveTenantId: (input: { slackTeamId: string }) => Promise<string | null>;
  prepareReview: (input: PrepareReviewRequest) => Promise<PreparedProposalReview>;
  openModal: (input: { triggerId: string; modal: ApprovalModal }) => Promise<{ viewId: string }>;
  recordReview: (input: PreparedProposalReview, modalId: string) => Promise<void>;
  dismissReview: (input: DismissProposalRequest) => Promise<void>;
  submitApproval: (input: ApprovalRequest) => Promise<{ approvalId: string; jobId: string }>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function slackId(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SLACK_ID.test(parsed)) throw new Error(`${label}_invalid`);
  return parsed;
}

function getRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label}_invalid`);
  return value;
}

function getTeamId(payload: UnknownRecord): string {
  const team = isRecord(payload.team) ? payload.team.id : undefined;
  return slackId(team, "slack_team_id");
}

function getChannelId(payload: UnknownRecord): string {
  const channel = isRecord(payload.channel) ? payload.channel.id : undefined;
  const container = isRecord(payload.container) ? payload.container.channel_id : undefined;
  return slackId(channel ?? container, "slack_channel_id");
}

function getUserId(payload: UnknownRecord): string {
  const user = getRecord(payload.user, "slack_user");
  return slackId(user.id, "slack_user_id");
}

function getTenantId(teamId: string, dependencies: SlackInteractionDependencies): Promise<string> {
  return dependencies.resolveTenantId({ slackTeamId: teamId }).then((tenantId) => {
    if (!tenantId) throw new Error("tenant_unavailable");
    return text(tenantId, "tenant_id");
  });
}

function getAction(payload: UnknownRecord): { actionId: string; proposalId: string; version: number } {
  if (!Array.isArray(payload.actions) || payload.actions.length !== 1) throw new Error("action_invalid");
  const action = getRecord(payload.actions[0], "action");
  const actionId = text(action.action_id, "action_id");
  const value = text(action.value, "action_value");
  const match = PROPOSAL_ACTION.exec(value);
  if (!match) throw new Error("action_value_invalid");
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) throw new Error("action_value_invalid");
  return { actionId, proposalId: match[1], version };
}

function parsePrivateMetadata(value: unknown): ApprovalBinding {
  let metadata: unknown;
  try {
    metadata = JSON.parse(text(value, "private_metadata", 4_096));
  } catch {
    throw new Error("private_metadata_invalid");
  }
  if (!isRecord(metadata)) throw new Error("private_metadata_invalid");
  try {
    return ApprovalBindingSchema.parse({ ...metadata, actorSlackId: "U-placeholder" });
  } catch {
    throw new Error("private_metadata_invalid");
  }
}

function badRequest(error = "interaction_invalid"): SlackInteractionResponse {
  return { status: 400, body: { ok: false, error } };
}

function businessError(error: unknown): SlackInteractionResponse {
  if (error instanceof ApprovalError && error.code === "approval_unauthorized") {
    return { status: 200, body: { response_action: "errors", errors: { approval: "This proposal is not available for approval by this actor." } } };
  }
  return { status: 200, body: { ok: true } };
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
    if (prepared.result.proposalId !== proposalId || prepared.result.version !== version) throw new Error("review_binding_invalid");
    const opened = await dependencies.openModal({ triggerId, modal: renderApprovalModal(prepared.result) });
    const viewId = text(opened.viewId, "view_id");
    await dependencies.recordReview(prepared, viewId);
    return { status: 200, body: { ok: true } };
  }
  if (actionId === "signal.dismiss_proposal") {
    if (version < 1) throw new Error("action_value_invalid");
    await dependencies.dismissReview({ ...request, version });
    return { status: 200, body: { ok: true } };
  }
  throw new Error("action_unknown");
}

async function handleViewSubmission(payload: UnknownRecord, dependencies: SlackInteractionDependencies): Promise<SlackInteractionResponse> {
  const view = getRecord(payload.view, "view");
  if (view.callback_id !== "signal.approve_proposal") throw new Error("callback_unknown");
  const modalId = text(view.id, "view_id");
  const actorSlackId = getUserId(payload);
  const slackTeamId = getTeamId(payload);
  const binding = parsePrivateMetadata(view.private_metadata);
  if (binding.slackTeamId !== slackTeamId) throw new Error("approval_context_invalid");
  const channelId = binding.channelId;
  const tenantId = await getTenantId(slackTeamId, dependencies);
  const request: ApprovalRequest = { ...binding, tenantId, channelId, actorSlackId, modalId };
  await dependencies.submitApproval(request);
  return { status: 200, body: { ok: true } };
}

export async function handleSlackInteraction(rawBody: string, dependencies: SlackInteractionDependencies): Promise<SlackInteractionResponse> {
  if (typeof rawBody !== "string" || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: "interaction_too_large" } };
  let payload: unknown;
  try {
    const encoded = new URLSearchParams(rawBody).get("payload");
    if (!encoded) return badRequest("payload_missing");
    payload = JSON.parse(encoded);
  } catch {
    return badRequest("payload_invalid");
  }
  try {
    const record = getRecord(payload, "payload");
    if (record.type === "block_actions") return await handleBlockAction(record, dependencies);
    if (record.type === "view_submission") return await handleViewSubmission(record, dependencies);
    return badRequest("interaction_type_unknown");
  } catch (error: unknown) {
    if (error instanceof ApprovalError) return businessError(error);
    return badRequest(error instanceof Error ? error.message : "interaction_invalid");
  }
}
