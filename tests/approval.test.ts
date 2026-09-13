import assert from "node:assert/strict";
import { test } from "node:test";
import { payloadHash, type Mutation } from "../src/domain/contracts";
import { ApprovalError, dismissProposal, openProposalReview, prepareProposalReview, recordProposalReview, renderApprovalModal, submitProposalApproval, type ApprovalDependencies, type ApprovalProposal, type ApprovalRequest, type PrepareReviewRequest, type ProposalReview } from "../src/services/approve";

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
  payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation }),
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
      tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: proposal.payloadHash,
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
      tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 2, payloadHash: proposal.payloadHash,
      expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "modal-1",
    }, dependencies({ loadReview: async () => ({ tenantId: "tenant-1", proposalId: "proposal-1", modalId: "modal-1", actorSlackId: "U1", slackTeamId: "T1", channelId: "C1", version: 2 }) })),
    (error: unknown) => error instanceof ApprovalError && error.code === "approval_stale",
  );
});

test("submits only the persisted binding and does not trust browser payload values", async () => {
  let binding: unknown;
  const result = await submitProposalApproval({
    tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: proposal.payloadHash,
    expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "modal-1",
  }, dependencies({ approve: async (input) => { binding = input; return { approvalId: "approval-1", jobId: "job-1" }; } }));

  assert.deepEqual(result, { approvalId: "approval-1", jobId: "job-1" });
  assert.deepEqual(binding, {
    tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: proposal.payloadHash,
    expiresAt: "2026-09-12T13:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "modal-1",
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

const reviewRequest: PrepareReviewRequest = {
  tenantId: "tenant-1", proposalId: "proposal-1", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1",
};

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    ...reviewRequest, operationId: "op-1", version: 1, payloadHash: proposal.payloadHash,
    expiresAt: "2026-09-12T13:00:00.000Z", modalId: "modal-1", ...overrides,
  };
}

function approvalError(code: ApprovalError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ApprovalError && error.code === code;
}

test("denies review and dismissal to actors who are not current named approvers", async () => {
  let writes = 0;
  const deps = dependencies({
    isNamedApprover: async () => false,
    recordReview: async () => { writes++; },
    dismiss: async () => { writes++; },
  });
  await assert.rejects(openProposalReview({ ...reviewRequest, modalId: "modal-1" }, deps), approvalError("approval_unauthorized"));
  await assert.rejects(dismissProposal({ ...reviewRequest, version: 1 }, deps), approvalError("approval_unauthorized"));
  assert.equal(writes, 0);
});

test("does not record a modal when authority is revoked while Slack opens it", async () => {
  const prepared = await prepareProposalReview(reviewRequest, dependencies());
  let recorded = false;
  await assert.rejects(recordProposalReview(prepared, "modal-1", dependencies({
    isNamedApprover: async () => false,
    recordReview: async () => { recorded = true; },
  })), approvalError("approval_unauthorized"));
  assert.equal(recorded, false);
});

test("does not record a modal when its proposal is superseded while Slack opens it", async () => {
  const prepared = await prepareProposalReview(reviewRequest, dependencies());
  let recorded = false;
  await assert.rejects(recordProposalReview(prepared, "modal-1", dependencies({
    loadProposal: async () => ({ ...proposal, state: "SUPERSEDED" }),
    recordReview: async () => { recorded = true; },
  })), approvalError("approval_stale"));
  assert.equal(recorded, false);
});

test("does not persist a review whose displayed target differs from the current proposal", async () => {
  const prepared = await prepareProposalReview(reviewRequest, dependencies());
  let recorded = false;
  const changed = { ...prepared, result: { ...prepared.result, mutation: { ...mutation, repo: "other" } } };
  await assert.rejects(recordProposalReview(changed, "modal-1", dependencies({ recordReview: async () => { recorded = true; } })), approvalError("approval_stale"));
  assert.equal(recorded, false);
});

test("rejects a different proposal returned by a tenant-scoped lookup", async () => {
  await assert.rejects(prepareProposalReview(reviewRequest, dependencies({
    loadProposal: async () => ({ ...proposal, proposalId: "proposal-2" }),
  })), approvalError("approval_not_found"));
});

for (const modalId of ["", " ", " modal-1", "modal-1\n"]) {
  test(`rejects invalid modal identity before repository lookup (${JSON.stringify(modalId)})`, async () => {
    let lookedUp = false;
    await assert.rejects(submitProposalApproval(approvalRequest({ modalId }), dependencies({
      loadReview: async () => { lookedUp = true; return null; },
    })), approvalError("approval_invalid_request"));
    assert.equal(lookedUp, false);
  });
}

for (const key of ["tenantId", "proposalId", "operationId", "actorSlackId", "slackTeamId", "channelId"] as const) {
  test(`rejects whitespace-normalized approval ${key}`, async () => {
    let approved = false;
    const input = approvalRequest();
    input[key] = ` ${input[key]} `;
    await assert.rejects(submitProposalApproval(input, dependencies({ approve: async () => {
      approved = true;
      return { approvalId: "approval-1", jobId: "job-1" };
    } })), approvalError("approval_invalid_request"));
    assert.equal(approved, false);
  });
}

for (const key of ["tenantId", "proposalId", "modalId", "actorSlackId", "slackTeamId", "channelId", "version"] as const) {
  test(`rejects a persisted review with a different ${key}`, async () => {
    const original = (await dependencies().loadReview({ tenantId: "tenant-1", proposalId: "proposal-1", modalId: "modal-1" }))!;
    const changed: ProposalReview = { ...original, [key]: key === "version" ? 2 : "other" };
    let approved = false;
    await assert.rejects(submitProposalApproval(approvalRequest(), dependencies({
      loadReview: async () => changed,
      approve: async () => { approved = true; return { approvalId: "approval-1", jobId: "job-1" }; },
    })), approvalError("approval_unauthorized"));
    assert.equal(approved, false);
  });
}

const changedMutations: [string, Mutation][] = [
  ["repository ID", { ...mutation, repoId: "repo-2" }],
  ["repository owner", { ...mutation, owner: "other" }],
  ["repository name", { ...mutation, repo: "other" }],
  ["title", { ...mutation, title: "Different title" }],
  ["body", { ...mutation, body: "Different body\n<!-- signal-operation:op-1 -->" }],
  ["assignee", { ...mutation, assignees: ["other"] }],
  ["trailing whitespace", { ...mutation, body: `${mutation.body} ` }],
  ["line endings", { ...mutation, body: mutation.body.replaceAll("\n", "\r\n") }],
  ["operation marker", { ...mutation, body: mutation.body.replace("op-1", "op-other") }],
];

for (const [name, changedMutation] of changedMutations) {
  test(`rejects changed persisted ${name} under the reviewed hash`, async () => {
    let approved = false;
    const deps = dependencies({
      loadProposal: async () => ({ ...proposal, mutation: changedMutation }),
      approve: async () => { approved = true; return { approvalId: "approval-1", jobId: "job-1" }; },
    });
    await assert.rejects(submitProposalApproval(approvalRequest(), deps), approvalError("approval_stale"));
    await assert.rejects(prepareProposalReview(reviewRequest, deps), approvalError("approval_stale"));
    assert.equal(approved, false);
  });
}

test("rejects a changed progress-comment issue identity under the reviewed hash", async () => {
  const comment: Mutation = { kind: "ADD_PROGRESS_COMMENT", repoId: "repo-1", owner: "acme", repo: "signal", issueId: "issue-1", issueNumber: 1, body: mutation.body };
  const hash = payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation: comment });
  for (const changed of [{ ...comment, issueId: "issue-2" }, { ...comment, issueNumber: 2 }]) {
    await assert.rejects(submitProposalApproval(approvalRequest({ payloadHash: hash }), dependencies({
      loadProposal: async () => ({ ...proposal, mutation: changed, payloadHash: hash }),
    })), approvalError("approval_stale"));
  }
});

for (const state of ["DISMISSED", "SUPERSEDED", "EXPIRED"] as const) {
  test(`does not send ${state} proposals through the approval mutation dependency`, async () => {
    let approved = false;
    await assert.rejects(submitProposalApproval(approvalRequest(), dependencies({
      loadProposal: async () => ({ ...proposal, state }),
      approve: async () => { approved = true; return { approvalId: "approval-1", jobId: "job-1" }; },
    })), approvalError("approval_stale"));
    assert.equal(approved, false);
  });
}

test("returns the atomic repository's recorded result for an exact approval replay", async () => {
  let state: ApprovalProposal["state"] = "PENDING";
  const bindings: ApprovalRequest[] = [];
  const deps = dependencies({
    loadProposal: async () => ({ ...proposal, state }),
    approve: async (input) => {
      bindings.push(input);
      state = "APPROVED";
      return { approvalId: "existing-approval", jobId: "original-job" };
    },
  });
  const expected = { approvalId: "existing-approval", jobId: "original-job" };
  assert.deepEqual(await submitProposalApproval(approvalRequest(), deps), expected);
  assert.deepEqual(await submitProposalApproval(approvalRequest(), deps), expected);
  assert.deepEqual(bindings, [approvalRequest(), approvalRequest()]);
});

test("does not erase an expired approval's recorded result on an exact replay", async () => {
  assert.deepEqual(await submitProposalApproval(approvalRequest(), dependencies({
    now: () => new Date("2026-09-12T14:00:00.000Z"),
    loadProposal: async () => ({ ...proposal, state: "APPROVED" }),
    approve: async () => ({ approvalId: "existing-approval", jobId: "original-job" }),
  })), { approvalId: "existing-approval", jobId: "original-job" });
});

test("rejects a replay from another modal even when that modal has its own matching review", async () => {
  let atomicInput: ApprovalRequest | undefined;
  await assert.rejects(submitProposalApproval(approvalRequest({ modalId: "second-modal" }), dependencies({
    loadProposal: async () => ({ ...proposal, state: "APPROVED" }),
    loadReview: async () => ({ ...reviewRequest, version: 1, modalId: "second-modal" }),
    approve: async (input) => { atomicInput = input; throw new Error("atomic replay binding mismatch"); },
  })), approvalError("approval_stale"));
  assert.equal(atomicInput?.modalId, "second-modal");
});

test("fails closed for invalid clocks and exact expiry", async () => {
  for (const now of [new Date("invalid"), proposal.expiresAt]) {
    await assert.rejects(submitProposalApproval(approvalRequest(), dependencies({ now: () => now })), approvalError("approval_stale"));
  }
  await assert.rejects(submitProposalApproval(approvalRequest(), dependencies({
    loadProposal: async () => ({ ...proposal, expiresAt: new Date("invalid") }),
  })), approvalError("approval_stale"));
});

test("does not approve after expiry passes during the named-actor check", async () => {
  let now = new Date("2026-09-12T12:59:59.999Z");
  let approved = false;
  await assert.rejects(submitProposalApproval(approvalRequest(), dependencies({
    now: () => now,
    isNamedApprover: async () => { now = proposal.expiresAt; return true; },
    approve: async () => { approved = true; return { approvalId: "approval-1", jobId: "job-1" }; },
  })), approvalError("approval_stale"));
  assert.equal(approved, false);
});

test("sanitizes failed proposal and review lookups", async () => {
  for (const key of ["loadProposal", "loadReview"] as const) {
    await assert.rejects(submitProposalApproval(approvalRequest(), dependencies({
      [key]: async () => { throw new Error("synthetic-private-detail"); },
    })), (error: unknown) => approvalError("approval_persistence_failed")(error) && !(error as Error).message.includes("synthetic-private-detail"));
  }
});

for (const [name, changed] of [
  ["operation", { operationId: "op-2" }],
  ["hash", { payloadHash: "b".repeat(64) }],
  ["team", { slackTeamId: "T2" }],
  ["channel", { channelId: "C2" }],
  ["expiry", { expiresAt: "2026-09-12T13:00:00.001Z" }],
  ["equivalent expiry representation", { expiresAt: "2026-09-12T08:00:00.000-05:00" }],
] satisfies [string, Partial<ApprovalRequest>][]) {
  test(`rejects changed submitted ${name} even when its modal context matches`, async () => {
    const input = approvalRequest(changed);
    let approved = false;
    await assert.rejects(submitProposalApproval(input, dependencies({
      loadReview: async () => ({ ...reviewRequest, slackTeamId: input.slackTeamId, channelId: input.channelId, modalId: input.modalId, version: input.version }),
      approve: async () => { approved = true; return { approvalId: "a", jobId: "j" }; },
    })), approvalError("approval_stale"));
    assert.equal(approved, false);
  });
}

test("cannot approve without a persisted modal review", async () => {
  let approved = false;
  await assert.rejects(submitProposalApproval(approvalRequest(), dependencies({
    loadReview: async () => null,
    approve: async () => { approved = true; return { approvalId: "a", jobId: "j" }; },
  })), approvalError("approval_unauthorized"));
  assert.equal(approved, false);
});

test("passes the exact named actor and channel context into atomic dismissal", async () => {
  const writes: unknown[] = [];
  await dismissProposal({ ...reviewRequest, version: 1 }, dependencies({ dismiss: async (input) => { writes.push(input); } }));
  assert.deepEqual(writes, [{ tenantId: "tenant-1", proposalId: "proposal-1", version: 1, slackTeamId: "T1", channelId: "C1", actorSlackId: "U1" }]);
});

test("does not dismiss with an empty actor or after expiry during its policy check", async () => {
  let dismissed = false;
  const deps = dependencies({ dismiss: async () => { dismissed = true; } });
  await assert.rejects(dismissProposal({ ...reviewRequest, actorSlackId: "", version: 1 }, deps), approvalError("approval_invalid_request"));
  let now = new Date("2026-09-12T12:59:59.999Z");
  await assert.rejects(dismissProposal({ ...reviewRequest, version: 1 }, {
    ...deps,
    now: () => now,
    isNamedApprover: async () => { now = proposal.expiresAt; return true; },
  }), approvalError("approval_stale"));
  assert.equal(dismissed, false);
});

test("validates a progress comment without changing its immutable payload", async () => {
  const comment: Mutation = { kind: "ADD_PROGRESS_COMMENT", repoId: "repo-1", owner: "acme", repo: "signal", issueId: "issue-1", issueNumber: 1, body: "Résumé approved.\n<!-- signal-operation:op-1 -->" };
  const hash = payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation: comment });
  const deps = dependencies({ loadProposal: async () => ({ ...proposal, mutation: comment, payloadHash: hash }) });
  const prepared = await prepareProposalReview(reviewRequest, deps);
  assert.deepEqual(prepared.result.mutation, comment);
  assert.deepEqual(await submitProposalApproval(approvalRequest({ payloadHash: hash }), deps), { approvalId: "approval-1", jobId: "job-1" });
  assert.equal(comment.body, "Résumé approved.\n<!-- signal-operation:op-1 -->");
});
