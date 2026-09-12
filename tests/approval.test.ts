import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mutation } from "../src/domain/contracts";
import { ApprovalError, dismissProposal, openProposalReview, prepareProposalReview, recordProposalReview, renderApprovalModal, submitProposalApproval, type ApprovalDependencies, type ApprovalProposal } from "../src/services/approve";

const mutation: Mutation = {
  kind: "CREATE_ISSUE",
  repoId: "repo-1",
  owner: "acme",
  repo: "signal",
  title: "Ship release",
  body: "Approved body\n<!-- signal-operation:op-1 -->",
  assignees: [],
};

const proposal: ApprovalProposal = {
  tenantId: "tenant-1",
  proposalId: "proposal-1",
  operationId: "op-1",
  version: 1,
  payloadHash: "a".repeat(64),
  expiresAt: new Date("2026-09-12T13:00:00.000Z"),
  state: "PENDING",
  slackTeamId: "T1",
  channelId: "C1",
  mutation,
};

function dependencies(overrides: Partial<ApprovalDependencies> = {}): ApprovalDependencies {
  return {
    now: () => new Date("2026-09-12T12:30:00.000Z"),
    loadProposal: async () => proposal,
    recordReview: async () => undefined,
    loadReview: async () => ({
      tenantId: "tenant-1",
      proposalId: "proposal-1",
      modalId: "modal-1",
      actorSlackId: "U1",
      slackTeamId: "T1",
      channelId: "C1",
      version: 1,
    }),
    isNamedApprover: async () => true,
    approve: async () => ({ approvalId: "approval-1", jobId: "job-1" }),
    dismiss: async () => undefined,
    ...overrides,
  };
}

test("opens a review only for a pending, unexpired proposal and records modal identity", async () => {
  const reviews: unknown[] = [];
  const result = await openProposalReview({
    tenantId: "tenant-1", proposalId: "proposal-1", slackTeamId: "T1", channelId: "C1", actorSlackId: "U2", modalId: "modal-1",
  }, dependencies({ recordReview: async (input) => { reviews.push(input); } }));

  assert.equal(result.proposalId, "proposal-1");
  assert.deepEqual(result.mutation, mutation);
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0], {
    tenantId: "tenant-1", proposalId: "proposal-1", modalId: "modal-1", actorSlackId: "U2", slackTeamId: "T1", channelId: "C1", version: 1,
  });
});

test("prepares a review before Slack assigns the modal id and records the returned id", async () => {
  const prepared = await prepareProposalReview({
    tenantId: "tenant-1", proposalId: "proposal-1", slackTeamId: "T1", channelId: "C1", actorSlackId: "U2",
  }, dependencies());
  const reviews: unknown[] = [];

  await recordProposalReview(prepared, "V-real-view-id", dependencies({ recordReview: async (input) => { reviews.push(input); } }));

  assert.equal(prepared.result.proposalId, "proposal-1");
  assert.deepEqual(reviews, [{
    tenantId: "tenant-1", proposalId: "proposal-1", modalId: "V-real-view-id", actorSlackId: "U2", slackTeamId: "T1", channelId: "C1", version: 1,
  }]);
});

test("requires the named approver and exact review metadata before approval", async () => {
  let approved = false;
  await assert.rejects(
    submitProposalApproval({
      tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: "a".repeat(64),
      expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "modal-1",
    }, dependencies({
      isNamedApprover: async () => false,
      approve: async () => { approved = true; return { approvalId: "a", jobId: "j" }; },
    })),
    (error: unknown) => error instanceof ApprovalError && error.code === "approval_unauthorized",
  );
  assert.equal(approved, false);

  await assert.rejects(
    submitProposalApproval({
      tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 2, payloadHash: "a".repeat(64),
      expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "modal-1",
    }, dependencies({ loadReview: async () => ({ tenantId: "tenant-1", proposalId: "proposal-1", modalId: "modal-1", actorSlackId: "U1", slackTeamId: "T1", channelId: "C1", version: 2 }) })),
    (error: unknown) => error instanceof ApprovalError && error.code === "approval_stale",
  );
});

test("submits only the persisted binding and does not trust browser payload values", async () => {
  let binding: unknown;
  const result = await submitProposalApproval({
    tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: "a".repeat(64),
    expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "modal-1",
  }, dependencies({ approve: async (input) => { binding = input; return { approvalId: "approval-1", jobId: "job-1" }; } }));

  assert.deepEqual(result, { approvalId: "approval-1", jobId: "job-1" });
  assert.deepEqual(binding, {
    tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: "a".repeat(64),
    expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1",
  });
});

test("rejects cross-tenant or cross-channel review hints without persistence", async () => {
  let recorded = false;
  await assert.rejects(
    openProposalReview({ tenantId: "tenant-2", proposalId: "proposal-1", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "modal-1" }, dependencies({ recordReview: async () => { recorded = true; } })),
    (error: unknown) => error instanceof ApprovalError && error.code === "approval_not_found",
  );
  assert.equal(recorded, false);
});

test("does not dismiss a stale proposal-card version", async () => {
  let dismissed = false;
  await assert.rejects(
    dismissProposal({ tenantId: "tenant-1", proposalId: "proposal-1", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", version: 2 }, dependencies({ dismiss: async () => { dismissed = true; } })),
    (error: unknown) => error instanceof ApprovalError && error.code === "approval_stale",
  );
  assert.equal(dismissed, false);
});

test("renders a read-only modal with complete escaped payload data and no technical marker", async () => {
  const review = await openProposalReview({ tenantId: "tenant-1", proposalId: "proposal-1", slackTeamId: "T1", channelId: "C1", actorSlackId: "U2", modalId: "modal-1" }, dependencies());
  const modal = renderApprovalModal(review);
  assert.equal(modal.type, "modal");
  assert.equal(modal.callback_id, "signal.approve_proposal");
  assert.equal(modal.private_metadata, review.privateMetadata);
  assert.equal(JSON.stringify(modal).includes("signal-operation"), false);
  assert.match(JSON.stringify(modal), /Ship release/);
  assert.ok(modal.blocks.every((block) => JSON.stringify(block).length <= 3_000));
});
