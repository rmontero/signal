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
    github: { createIssue: async ({ signal, ...input }) => { assert.ok(signal instanceof AbortSignal); calls.push(input); return { id: "9001", number: 9, url: "https://github.com/acme/signal/issues/9", assignees: [] }; }, addProgressComment: async () => { throw new Error("unexpected comment"); } },
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
    github: { createIssue: async () => { throw new Error("unexpected issue creation"); }, addProgressComment: async ({ signal, ...input }) => { assert.ok(signal instanceof AbortSignal); posted = input; return { id: "9100", url: "https://github.com/acme/signal/issues/10#issuecomment-9100" }; } },
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

test("requires exact returned issue identity before persisting success", async () => {
  for (const change of [
    { id: "" }, { id: "009001" }, { id: "9007199254740992" }, { number: 0 },
    { url: "https://github.com/acme/signal/issues/9#issuecomment-1" },
    { url: "https://github.com/acme/signal/issues/9?other=result" },
    { url: "https://someone@github.com/acme/signal/issues/9" },
    { url: "https://github.com:444/acme/signal/issues/9" },
    { url: "https://github.com/acme//signal/issues/9" },
  ]) {
    let posts = 0;
    let successes = 0;
    const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
      github: { createIssue: async () => { posts += 1; return { id: "9001", number: 9, url: "https://github.com/acme/signal/issues/9", assignees: [], ...change }; }, addProgressComment: async () => { throw new Error("unexpected"); } },
      recordSuccess: async () => { successes += 1; return { jobId: "n" }; },
    }));
    assert.equal(result.state, "UNKNOWN");
    assert.equal(posts, 1);
    assert.equal(successes, 0);
  }
});

test("requires the returned comment ID to match its exact parent and URL fragment", async () => {
  for (const url of [
    "https://github.com/acme/signal/issues/10",
    "https://github.com/acme/signal/issues/10#issuecomment-9101",
    "https://github.com/acme/signal/issues/11#issuecomment-9100",
    "https://github.com/acme/signal/issues/10?x=1#issuecomment-9100",
  ]) {
    let successes = 0;
    const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-comment", attemptId: "attempt-1" }, dependencies({
      loadApprovedProposal: async () => ({ ...proposal, operationId: "op-comment", mutation: commentMutation, payloadHash: commentPayloadHash }),
      githubRead: { getIssue: async () => ({ id: "9010", number: 10, title: "Release", htmlUrl: "https://github.com/acme/signal/issues/10", state: "open", isPullRequest: false, authorLogin: null }) },
      github: { createIssue: async () => { throw new Error("unexpected"); }, addProgressComment: async () => ({ id: "9100", url }) },
      recordSuccess: async () => { successes += 1; return { jobId: "n" }; },
    }));
    assert.equal(result.state, "UNKNOWN");
    assert.equal(successes, 0);
  }
});

test("withholds a comment when the parent read returns an out-of-scope URL", async () => {
  let claims = 0;
  const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-comment", attemptId: "attempt-1" }, dependencies({
    loadApprovedProposal: async () => ({ ...proposal, operationId: "op-comment", mutation: commentMutation, payloadHash: commentPayloadHash }),
    githubRead: { getIssue: async () => ({ id: "9010", number: 10, title: "Release", htmlUrl: "https://github.com/other/repo/issues/10", state: "open", isPullRequest: false, authorLogin: null }) },
    claimMutation: async () => { claims += 1; return { fencingToken: 4 }; },
  }));
  assert.equal(result.state, "STALE");
  assert.equal(claims, 0);
});

test("refuses missing, duplicate, and foreign operation markers even with a matching hash", async () => {
  for (const body of ["No marker", `${mutation.body}\n<!-- signal-operation:op-1 -->`, `${mutation.body}\n<!-- signal-operation:other -->`]) {
    const changedMutation = { ...mutation, body };
    let claims = 0;
    await assert.rejects(executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
      loadApprovedProposal: async () => ({ ...proposal, mutation: changedMutation, payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation: changedMutation }) }),
      claimMutation: async () => { claims += 1; return { fencingToken: 4 }; },
    })), (error: unknown) => error instanceof ExecutionError && error.code === "execution_payload_mismatch");
    assert.equal(claims, 0);
  }
});

test("does not normalize persisted bytes into a hash match", async () => {
  let claims = 0;
  await assert.rejects(executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
    loadApprovedProposal: async () => ({ ...proposal, mutation: { ...mutation, title: " Ship release " } }),
    claimMutation: async () => { claims += 1; return { fencingToken: 4 }; },
  })), (error: unknown) => error instanceof ExecutionError && error.code === "execution_payload_mismatch");
  assert.equal(claims, 0);
});

test("invalid expiry and an expired approval after a slow target read cannot authorize a POST", async () => {
  await assert.rejects(executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
    loadApprovedProposal: async () => ({ ...proposal, expiresAt: new Date(NaN) }),
  })), (error: unknown) => error instanceof ExecutionError && error.code === "execution_stale");
  let now = new Date("2026-09-12T12:59:59.000Z");
  let claims = 0;
  await assert.rejects(executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-comment", attemptId: "attempt-1" }, dependencies({
    now: () => now,
    loadApprovedProposal: async () => ({ ...proposal, operationId: "op-comment", mutation: commentMutation, payloadHash: commentPayloadHash }),
    githubRead: { getIssue: async () => { now = new Date("2026-09-12T13:00:01.000Z"); return { id: "9010", number: 10, title: "Release", htmlUrl: "https://github.com/acme/signal/issues/10", state: "open", isPullRequest: false, authorLogin: null }; } },
    claimMutation: async () => { claims += 1; return { fencingToken: 4 }; },
  })), (error: unknown) => error instanceof ExecutionError && error.code === "execution_stale");
  assert.equal(claims, 0);
});

test("reports actual assignees and a dropped assignment without repeating creation", async () => {
  const assignedMutation: Mutation = { ...mutation, assignees: ["alice"] };
  for (const [assignees, mismatch] of [[[], true], [["bob"], true], [["Alice"], false]] as const) {
    let saved: Parameters<ExecutionDependencies["recordSuccess"]>[0] | undefined;
    let posts = 0;
    const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, dependencies({
      loadApprovedProposal: async () => ({ ...proposal, mutation: assignedMutation, payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation: assignedMutation }) }),
      github: { createIssue: async () => { posts += 1; return { id: "9001", number: 9, url: "https://github.com/acme/signal/issues/9", assignees: [...assignees] }; }, addProgressComment: async () => { throw new Error("unexpected"); } },
      recordSuccess: async (input) => { saved = input; return { jobId: "n" }; },
    }));
    assert.equal(result.state, "SUCCEEDED");
    assert.deepEqual(saved?.actualAssignees, assignees);
    assert.equal(saved?.assigneeMismatch, mismatch);
    assert.deepEqual(result.actualAssignees, assignees);
    assert.equal(result.assigneeMismatch, mismatch);
    assert.equal(posts, 1);
  }
});

test("a persistence exception after a successful POST is never classified as provider rejection", async () => {
  for (const persistenceError of [new Error("sensitive database detail"), new GitHubWriteError("github_rejected", "sensitive detail", { outcome: "definite_rejection" })]) {
    let posts = 0;
    let claimed = false;
    const outcomes: string[] = [];
    const clients = dependencies({
      claimMutation: async () => { if (claimed) return null; claimed = true; return { fencingToken: 4 }; },
      github: { createIssue: async () => { posts += 1; return { id: "9001", number: 9, url: "https://github.com/acme/signal/issues/9", assignees: [] }; }, addProgressComment: async () => { throw new Error("unexpected"); } },
      recordSuccess: async () => { throw persistenceError; },
      recordFailure: async () => { outcomes.push("FAILED"); },
      recordUnknown: async () => { outcomes.push("UNKNOWN"); },
    });
    await assert.rejects(executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, clients), (error: unknown) => error instanceof ExecutionError && error.code === "execution_persistence_failed" && !error.message.includes("sensitive"));
    assert.equal((await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-2" }, clients)).state, "IN_PROGRESS");
    assert.deepEqual(outcomes, []);
    assert.equal(posts, 1);
  }
});

test("duplicate delivery during SENDING and after UNKNOWN never posts again", async () => {
  let state: "READY" | "SENDING" | "UNKNOWN" = "READY";
  let posts = 0;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let finishPost!: () => void;
  const pendingPost = new Promise<void>((resolve) => { finishPost = resolve; });
  const clients = dependencies({
    claimMutation: async () => { if (state !== "READY") return null; state = "SENDING"; return { fencingToken: 4 }; },
    github: { createIssue: async () => { posts += 1; signalStarted(); await pendingPost; throw new GitHubWriteError("github_unknown", "timeout", { outcome: "unknown" }); }, addProgressComment: async () => { throw new Error("unexpected"); } },
    recordUnknown: async () => { state = "UNKNOWN"; },
  });
  const first = executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1" }, clients);
  await started;
  assert.equal((await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-2" }, clients)).state, "IN_PROGRESS");
  finishPost();
  assert.equal((await first).state, "UNKNOWN");
  assert.equal((await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-3" }, clients)).state, "IN_PROGRESS");
  assert.equal(posts, 1);
});

test("aborts a stalled POST within its lease and records only uncertainty", async () => {
  let requestSignal: AbortSignal | undefined;
  let posts = 0;
  let unknown = 0;
  const keepAlive = setTimeout(() => undefined, 1_000);
  try {
    const result = await executeApprovedProposal({ tenantId: "tenant-1", operationId: "op-1", attemptId: "attempt-1", leaseDurationMs: 20 }, dependencies({
      github: { createIssue: async ({ signal }) => {
        posts += 1;
        requestSignal = signal;
        if (!signal) throw new Error("deadline absent");
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        throw new GitHubWriteError("github_unknown", "timeout", { outcome: "unknown" });
      }, addProgressComment: async () => { throw new Error("unexpected"); } },
      recordUnknown: async () => { unknown += 1; },
    }));
    assert.equal(result.state, "UNKNOWN");
    assert.equal(requestSignal?.aborted, true);
    assert.equal(posts, 1);
    assert.equal(unknown, 1);
  } finally { clearTimeout(keepAlive); }
});
