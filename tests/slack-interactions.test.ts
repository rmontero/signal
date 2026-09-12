import assert from "node:assert/strict";
import { test } from "node:test";
import { renderApprovalModal, type ApprovalRequest, type PreparedProposalReview, type ReviewResult } from "../src/services/approve";
import { handleSlackInteraction, type SlackInteractionDependencies } from "../src/services/slack-interactions";

const review: ReviewResult = {
  proposalId: "proposal-1",
  version: 1,
  mutation: {
    kind: "CREATE_ISSUE",
    repoId: "repo-1",
    owner: "acme",
    repo: "signal",
    title: "Ship release",
    body: "Ship it",
    assignees: [],
  },
  expiresAt: "2026-09-12T13:00:00.000Z",
  privateMetadata: JSON.stringify({
    tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: "a".repeat(64), expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1",
  }),
};

const prepared: PreparedProposalReview = {
  result: review,
  review: { tenantId: "tenant-1", proposalId: "proposal-1", actorSlackId: "U1", slackTeamId: "T1", channelId: "C1", version: 1 },
};

function body(payload: unknown): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function dependencies(overrides: Partial<SlackInteractionDependencies> = {}): SlackInteractionDependencies {
  return {
    resolveTenantId: async () => "tenant-1",
    prepareReview: async () => prepared,
    openModal: async () => ({ viewId: "V-real-view-id" }),
    recordReview: async () => undefined,
    dismissReview: async () => undefined,
    submitApproval: async () => ({ approvalId: "approval-1", jobId: "job-1" }),
    ...overrides,
  };
}

test("opens a review modal and persists the Slack-assigned view id", async () => {
  let opened: unknown;
  let recorded: unknown;
  const response = await handleSlackInteraction(body({
    type: "block_actions",
    user: { id: "U1" },
    team: { id: "T1" },
    channel: { id: "C1" },
    trigger_id: "13345224609.738474920.8088930838",
    actions: [{ action_id: "signal.review_proposal", value: "proposal-1:1" }],
  }), dependencies({
    openModal: async (input) => { opened = input; return { viewId: "V-real-view-id" }; },
    recordReview: async (input, modalId) => { recorded = { prepared: input, modalId }; },
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(recorded, { prepared, modalId: "V-real-view-id" });
  assert.equal((opened as { triggerId: string }).triggerId, "13345224609.738474920.8088930838");
  assert.deepEqual((opened as { modal: unknown }).modal, renderApprovalModal(review));
});

test("dismisses only the proposal selected by the signed Slack action context", async () => {
  let dismissed: unknown;
  const response = await handleSlackInteraction(body({
    type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" },
    actions: [{ action_id: "signal.dismiss_proposal", value: "proposal-1:1" }],
  }), dependencies({ dismissReview: async (input) => { dismissed = input; } }));

  assert.equal(response.status, 200);
  assert.deepEqual(dismissed, { tenantId: "tenant-1", proposalId: "proposal-1", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", version: 1 });
});

test("submits view approval using only validated private metadata and Slack identity", async () => {
  let submitted: ApprovalRequest | undefined;
  const response = await handleSlackInteraction(body({
    type: "view_submission",
    user: { id: "U1" },
    team: { id: "T1" },
    view: { id: "V-real-view-id", callback_id: "signal.approve_proposal", private_metadata: review.privateMetadata },
  }), dependencies({ submitApproval: async (input) => { submitted = input; return { approvalId: "approval-1", jobId: "job-1" }; } }));

  assert.equal(response.status, 200);
  assert.deepEqual(submitted, {
    tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: "a".repeat(64),
    expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "V-real-view-id",
  });
});

test("rejects malformed, oversized, unknown, and tampered Slack interaction payloads", async () => {
  assert.equal((await handleSlackInteraction("payload=%7B", dependencies())).status, 400);
  assert.equal((await handleSlackInteraction("x".repeat(64 * 1024 + 1), dependencies())).status, 413);
  assert.equal((await handleSlackInteraction(body({ type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" }, actions: [{ action_id: "signal.unknown", value: "proposal-1:1" }] }), dependencies())).status, 400);
  assert.equal((await handleSlackInteraction(body({ type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" }, actions: [{ action_id: "signal.review_proposal", value: "proposal-1:not-a-version" }] }), dependencies())).status, 400);
  assert.equal((await handleSlackInteraction(body({ type: "view_submission", user: { id: "U1" }, team: { id: "T2" }, view: { id: "V1", callback_id: "signal.approve_proposal", private_metadata: review.privateMetadata } }), dependencies())).status, 400);
});
