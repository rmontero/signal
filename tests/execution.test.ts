import assert from "node:assert/strict";
import { test } from "node:test";
import { payloadHash, type Mutation } from "../src/domain/contracts";
import { ExecutionError, executeApprovedProposal, type ExecutionDependencies, type ApprovedProposal } from "../src/services/execute";
// @ts-expect-error TS5097: the provider adapter remains .mts for standalone boundary tests.
import { GitHubWriteError } from "../src/adapters/github-write-standalone.mts";

const mutation: Mutation = {
  kind: "CREATE_ISSUE",
  repoId: "repo-1",
  owner: "acme",
  repo: "signal",
  title: "Ship release",
  body: "Approved body\n<!-- signal-operation:op-1 -->",
  assignees: [],
};

const validPayloadHash = payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation });
const commentMutation: Mutation = {
  kind: "ADD_PROGRESS_COMMENT",
  repoId: "repo-1",
  owner: "acme",
  repo: "signal",
  issueId: "9010",
  issueNumber: 10,
  body: "Progress update\n<!-- signal-operation:op-comment -->",
};
const commentPayloadHash = payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-comment", version: 1, mutation: commentMutation });

const proposal: ApprovedProposal = {
  tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1, payloadHash: validPayloadHash,
  expiresAt: new Date("2026-09-12T13:00:00.000Z"), state: "APPROVED", mutation,
};

function dependencies(overrides: Partial<ExecutionDependencies> = {}): ExecutionDependencies {
  return {
    now: () => new Date("2026-09-12T12:30:00.000Z"),
    loadApprovedProposal: async () => proposal,
    claimMutation: async () => ({ fencingToken: 4 }),
    github: {
      createIssue: async () => ({ id: "9001", number: 9, url: "https://github.com/acme/signal/issues/9", assignees: [] }),
      addProgressComment: async () => ({ id: "9100", url: "https://github.com/acme/signal/issues/9#issuecomment-9100" }),
    },
    recordSuccess: async () => ({ jobId: "notify-1" }),
    recordFailure: async () => undefined,
    recordUnknown: async () => undefined,
    recordStale: async () => undefined,
    ...overrides,
  };
}

test("claims an approved issue proposal and sends the exact persisted mutation once", async () => {
  const calls: unknown[] = [];
  const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
    claimMutation: async (input) => { calls.push(input); return { fencingToken: 4 }; },
    github: { createIssue: async (input) => { calls.push(input); return { id: "9001", number: 9, url: "https://github.com/acme/signal/issues/9", assignees: [] }; }, addProgressComment: async () => { throw new Error("unexpected comment"); } },
  }));

  assert.equal(result.state, "SUCCEEDED");
  assert.deepEqual(calls, [
    { tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1", leaseExpiresAt: result.leaseExpiresAt, },
    { owner: "acme", repo: "signal", title: "Ship release", body: mutation.body, assignees: [] },
  ]);
});

test("does not post when the fencing claim is lost", async () => {
  let posts = 0;
  const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
    claimMutation: async () => null,
    github: { createIssue: async () => { posts += 1; return { id: "1", number: 1, url: "https://github.com/acme/signal/issues/1", assignees: [] }; }, addProgressComment: async () => { throw new Error("unexpected"); } },
  }));
  assert.equal(result.state, "IN_PROGRESS");
  assert.equal(posts, 0);
});

test("records definitive rejection separately from unknown provider outcomes", async () => {
  const recorded: string[] = [];
  const rejected = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
    github: { createIssue: async () => { throw new GitHubWriteError("github_rejected", "rejected", { outcome: "definite_rejection" }); }, addProgressComment: async () => { throw new Error("unexpected"); } },
    recordFailure: async () => { recorded.push("failed"); },
  }));
  assert.equal(rejected.state, "FAILED");

  const unknown = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-2" }, dependencies({
    github: { createIssue: async () => { throw new GitHubWriteError("github_unknown", "timeout", { outcome: "unknown" }); }, addProgressComment: async () => { throw new Error("unexpected"); } },
    recordUnknown: async () => { recorded.push("unknown"); },
  }));
  assert.equal(unknown.state, "UNKNOWN");
  assert.deepEqual(recorded, ["failed", "unknown"]);
});

test("rejects a stale or tampered proposal before claiming mutation authority", async () => {
  let claimed = false;
  await assert.rejects(
    executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
      loadApprovedProposal: async () => ({ ...proposal, payloadHash: "c".repeat(64) }),
      claimMutation: async () => { claimed = true; return { fencingToken: 1 }; },
    })),
    (error: unknown) => error instanceof ExecutionError && error.code === "execution_payload_mismatch",
  );
  assert.equal(claimed, false);
});

test("does not mark success when GitHub returns an identity outside the approved repository", async () => {
  let unknown = false;
  const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
    github: {
      createIssue: async () => ({ id: "9001", number: 9, url: "https://github.com/other/repository/issues/9", assignees: [] }),
      addProgressComment: async () => { throw new Error("unexpected"); },
    },
    recordUnknown: async () => { unknown = true; },
  }));
  assert.equal(result.state, "UNKNOWN");
  assert.equal(unknown, true);
});

test("revalidates an open issue before sending an exact progress comment", async () => {
  const commentProposal: ApprovedProposal = { ...proposal, proposalId: "proposal-comment", operationId: "op-comment", payloadHash: commentPayloadHash, mutation: commentMutation };
  let posted: unknown;
  let read: unknown;
  const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-comment", attemptId: "attempt-comment" }, dependencies({
    loadApprovedProposal: async () => commentProposal,
    githubRead: { getIssue: async (input) => { read = input; return { id: "9010", number: 10, title: "Release", htmlUrl: "https://github.com/acme/signal/issues/10", state: "open", isPullRequest: false, authorLogin: null }; } },
    github: { createIssue: async () => { throw new Error("unexpected issue creation"); }, addProgressComment: async (input) => { posted = input; return { id: "comment-1", url: "https://github.com/acme/signal/issues/10#issuecomment-1" }; } },
  }));

  assert.equal(result.state, "SUCCEEDED");
  assert.deepEqual(read, { owner: "acme", repo: "signal", issueNumber: 10 });
  assert.deepEqual(posted, { owner: "acme", repo: "signal", issueNumber: 10, body: commentMutation.body });
});

test("does not post a comment when the target is closed, a pull request, or a different issue", async () => {
  const commentProposal: ApprovedProposal = { ...proposal, proposalId: "proposal-comment", operationId: "op-comment", payloadHash: commentPayloadHash, mutation: commentMutation };
  for (const target of [
    { id: "9010", number: 10, state: "closed" as const, isPullRequest: false },
    { id: "9010", number: 10, state: "open" as const, isPullRequest: true },
    { id: "9999", number: 10, state: "open" as const, isPullRequest: false },
  ]) {
    let posts = 0;
    let stale = 0;
    let claimed = 0;
    const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-comment", attemptId: `attempt-${target.id}-${target.state}-${target.isPullRequest}` }, dependencies({
      loadApprovedProposal: async () => commentProposal,
      claimMutation: async () => { claimed += 1; return { fencingToken: 4 }; },
      githubRead: { getIssue: async () => ({ ...target, title: "Release", htmlUrl: "https://github.com/acme/signal/issues/10", authorLogin: null }) },
      github: { createIssue: async () => { throw new Error("unexpected issue creation"); }, addProgressComment: async () => { posts += 1; return { id: "comment-1", url: "https://github.com/acme/signal/issues/10#issuecomment-1" }; } },
      recordStale: async () => { stale += 1; },
    }));
    assert.equal(result.state, "STALE");
    assert.equal(posts, 0);
    assert.equal(claimed, 0);
    assert.equal(stale, 1);
  }
});

test("blocks comment execution without a trustworthy target read and never posts", async () => {
  const commentProposal: ApprovedProposal = { ...proposal, proposalId: "proposal-comment", operationId: "op-comment", payloadHash: commentPayloadHash, mutation: commentMutation };
  let posts = 0;
  const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-comment", attemptId: "attempt-comment" }, dependencies({
    loadApprovedProposal: async () => commentProposal,
    githubRead: { getIssue: async () => { throw new Error("read unavailable"); } },
    github: { createIssue: async () => { throw new Error("unexpected issue creation"); }, addProgressComment: async () => { posts += 1; return { id: "comment-1", url: "https://github.com/acme/signal/issues/10#issuecomment-1" }; } },
  }));

  assert.equal(result.state, "BLOCKED");
  assert.equal(posts, 0);
});
