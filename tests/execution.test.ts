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
