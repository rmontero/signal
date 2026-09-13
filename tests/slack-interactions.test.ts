import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalError, renderApprovalModal, type ApprovalRequest, type PreparedProposalReview, type ReviewResult } from "../src/services/approve";
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

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "view_submission", user: { id: "U1" }, team: { id: "T1" },
    view: { id: "V-real-view-id", callback_id: "signal.approve_proposal", private_metadata: review.privateMetadata },
    ...overrides,
  };
}

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" },
    trigger_id: "valid-trigger", actions: [{ action_id: "signal.review_proposal", value: "proposal-1:1" }],
    ...overrides,
  };
}

test("rejects metadata from another tenant instead of rewriting it to the resolved tenant", async () => {
  let submitted = false;
  const metadata = { ...JSON.parse(review.privateMetadata), tenantId: "tenant-2" };
  const response = await handleSlackInteraction(body(submission({ view: {
    id: "V1", callback_id: "signal.approve_proposal", private_metadata: JSON.stringify(metadata),
  } })), dependencies({ submitApproval: async () => { submitted = true; return { approvalId: "a", jobId: "j" }; } }));
  assert.equal(response.status, 400);
  assert.equal(submitted, false);
});

for (const key of ["tenantId", "proposalId", "operationId", "slackTeamId", "channelId"] as const) {
  test(`rejects metadata with a normalized ${key}`, async () => {
    const metadata = JSON.parse(review.privateMetadata);
    metadata[key] = ` ${metadata[key]} `;
    let submitted = false;
    const response = await handleSlackInteraction(body(submission({ view: {
      id: "V1", callback_id: "signal.approve_proposal", private_metadata: JSON.stringify(metadata),
    } })), dependencies({ submitApproval: async () => { submitted = true; return { approvalId: "a", jobId: "j" }; } }));
    assert.equal(response.status, 400);
    assert.equal(submitted, false);
  });
}

test("rejects actor and mutation material injected into modal lookup metadata", async () => {
  for (const extra of [{ actorSlackId: "U2" }, { mutation: review.mutation }]) {
    let submitted = false;
    const response = await handleSlackInteraction(body(submission({ view: {
      id: "V1", callback_id: "signal.approve_proposal", private_metadata: JSON.stringify({ ...JSON.parse(review.privateMetadata), ...extra }),
    } })), dependencies({ submitApproval: async () => { submitted = true; return { approvalId: "a", jobId: "j" }; } }));
    assert.equal(response.status, 400);
    assert.equal(submitted, false);
  }
});

test("rejects mismatched or malformed channel and container identities before preparing a review", async () => {
  for (const override of [
    { container: { channel_id: "C2" } },
    { channel: null, container: { channel_id: "C1" } },
    { channel: { id: "C1" }, container: { channel_id: null } },
  ]) {
    let prepared = false;
    const response = await handleSlackInteraction(body(action(override)), dependencies({ prepareReview: async () => { prepared = true; return { result: review, review: { tenantId: "tenant-1", proposalId: "proposal-1", actorSlackId: "U1", slackTeamId: "T1", channelId: "C1", version: 1 } }; } }));
    assert.equal(response.status, 400);
    assert.equal(prepared, false);
  }
});

test("requires matching channel hints on a modal submission when hints are present", async () => {
  for (const override of [{ channel: { id: "C2" } }, { container: { channel_id: "C2" } }]) {
    let submitted = false;
    const response = await handleSlackInteraction(body(submission(override)), dependencies({ submitApproval: async () => { submitted = true; return { approvalId: "a", jobId: "j" }; } }));
    assert.equal(response.status, 400);
    assert.equal(submitted, false);
  }
});

test("rejects a bot or an actor whose explicit team differs from the interaction team", async () => {
  for (const user of [{ id: "U1", is_bot: true }, { id: "U1", bot_id: "B1" }, { id: "U1", team_id: "T2" }]) {
    let submitted = false;
    const response = await handleSlackInteraction(body(submission({ user })), dependencies({ submitApproval: async () => { submitted = true; return { approvalId: "a", jobId: "j" }; } }));
    assert.equal(response.status, 400);
    assert.equal(submitted, false);
  }
});

test("rejects ambiguous repeated form payload parameters", async () => {
  let submitted = false;
  const raw = `${body(submission())}&${body(submission())}`;
  const response = await handleSlackInteraction(raw, dependencies({ submitApproval: async () => { submitted = true; return { approvalId: "a", jobId: "j" }; } }));
  assert.equal(response.status, 400);
  assert.equal(submitted, false);
});

for (const key of ["tenantId", "proposalId", "actorSlackId", "slackTeamId", "channelId", "version"] as const) {
  test(`never opens a modal when the prepared review has a different ${key}`, async () => {
    let opened = false;
    const response = await handleSlackInteraction(body(action()), dependencies({
      prepareReview: async () => ({ ...prepared, review: { ...prepared.review, [key]: key === "version" ? 2 : "other" } }),
      openModal: async () => { opened = true; return { viewId: "V1" }; },
    }));
    assert.equal(response.status, 400);
    assert.equal(opened, false);
  });
}

test("never opens a modal whose metadata names another tenant or version", async () => {
  for (const changed of [{ tenantId: "tenant-2" }, { version: 2 }, { expiresAt: "2026-09-12T14:00:00.000Z" }]) {
    let opened = false;
    const response = await handleSlackInteraction(body(action()), dependencies({
      prepareReview: async () => ({ ...prepared, result: { ...review, privateMetadata: JSON.stringify({ ...JSON.parse(review.privateMetadata), ...changed }) } }),
      openModal: async () => { opened = true; return { viewId: "V1" }; },
    }));
    assert.equal(response.status, 400);
    assert.equal(opened, false);
  }
});

test("preserves signed actor identity regardless of browser-style actor and tenant hints", async () => {
  let submitted: ApprovalRequest | undefined;
  const response = await handleSlackInteraction(body(submission({ actorSlackId: "U2", tenantId: "tenant-2", mutation: { title: "Injected" } })), dependencies({
    submitApproval: async (input) => { submitted = input; return { approvalId: "a", jobId: "j" }; },
  }));
  assert.equal(response.status, 200);
  assert.equal(submitted?.actorSlackId, "U1");
  assert.equal(submitted?.tenantId, "tenant-1");
  assert.equal(Object.hasOwn(submitted!, "mutation"), false);
});

test("sanitizes unexpected dependency errors instead of returning their message", async () => {
  for (const key of ["resolveTenantId", "submitApproval"] as const) {
    const response = await handleSlackInteraction(body(submission()), dependencies({
      [key]: async () => { throw new Error("synthetic-private-detail"); },
    }));
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(response).includes("synthetic-private-detail"), false);
    assert.deepEqual(response.body, { ok: false, error: "interaction_unavailable" });
  }
});

test("reports review persistence failure without a successful acknowledgment", async () => {
  const response = await handleSlackInteraction(body(action()), dependencies({
    recordReview: async () => { throw new ApprovalError("approval_persistence_failed", "synthetic-private-detail"); },
  }));
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response).includes("synthetic-private-detail"), false);
});

test("shows submission denials in a private notice modal with no approval controls", async () => {
  for (const code of ["approval_unauthorized", "approval_stale", "approval_not_found", "approval_persistence_failed"] as const) {
    const response = await handleSlackInteraction(body(submission()), dependencies({
      submitApproval: async () => { throw new ApprovalError(code, "synthetic-private-detail"); },
    }));
    assert.equal(response.status, 200);
    assert.ok("response_action" in response.body && response.body.response_action === "update");
    assert.ok("view" in response.body);
    const view = response.body.view as Record<string, unknown>;
    assert.equal(view.type, "modal");
    assert.equal(Object.hasOwn(view, "submit"), false);
    assert.equal(Object.hasOwn(view, "private_metadata"), false);
    assert.equal(JSON.stringify(response).includes("synthetic-private-detail"), false);
  }
});

test("closes the modal explicitly after a persisted successful approval", async () => {
  const response = await handleSlackInteraction(body(submission()), dependencies());
  assert.deepEqual(response, { status: 200, body: { response_action: "clear" } });
});

test("opens a private notice for an unauthorized review or dismiss without shared-state writes", async () => {
  for (const actionId of ["signal.review_proposal", "signal.dismiss_proposal"]) {
    let notice: unknown;
    let reviewOpened = false;
    let reviewRecorded = false;
    const response = await handleSlackInteraction(body(action({ actions: [{ action_id: actionId, value: "proposal-1:1" }] })), dependencies({
      prepareReview: async () => { throw new ApprovalError("approval_unauthorized", "synthetic-private-detail"); },
      dismissReview: async () => { throw new ApprovalError("approval_unauthorized", "synthetic-private-detail"); },
      openNotice: async (input) => { notice = input; },
      openModal: async () => { reviewOpened = true; return { viewId: "V1" }; },
      recordReview: async () => { reviewRecorded = true; },
    }));
    assert.equal(response.status, 200);
    assert.equal(reviewOpened, false);
    assert.equal(reviewRecorded, false);
    assert.ok(notice);
    const shown = notice as { triggerId: string; modal: Record<string, unknown> };
    assert.equal(shown.triggerId, "valid-trigger");
    assert.equal(shown.modal.type, "modal");
    assert.equal(Object.hasOwn(shown.modal, "submit"), false);
    assert.equal(Object.hasOwn(shown.modal, "private_metadata"), false);
    assert.equal(JSON.stringify(notice).includes("synthetic-private-detail"), false);
  }
});

test("denies without leaking details when the private-notice hook is not configured", async () => {
  const response = await handleSlackInteraction(body(action()), dependencies({
    prepareReview: async () => { throw new ApprovalError("approval_unauthorized", "synthetic-private-detail"); },
  }));
  assert.deepEqual(response, { status: 200, body: { ok: false, error: "approval_unauthorized" } });
});

test("sanitizes private-notice transport failure", async () => {
  const response = await handleSlackInteraction(body(action()), dependencies({
    prepareReview: async () => { throw new ApprovalError("approval_unauthorized", "synthetic-private-detail"); },
    openNotice: async () => { throw new Error("synthetic-transport-detail"); },
  }));
  assert.deepEqual(response, { status: 500, body: { ok: false, error: "interaction_unavailable" } });
});

test("does not reuse an already-consumed Slack trigger when review recording loses authority", async () => {
  let notices = 0;
  const response = await handleSlackInteraction(body(action()), dependencies({
    recordReview: async () => { throw new ApprovalError("approval_unauthorized", "synthetic-private-detail"); },
    openNotice: async () => { notices++; },
  }));
  assert.equal(response.status, 500);
  assert.equal(notices, 0);
});
