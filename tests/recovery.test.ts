import assert from "node:assert/strict";
import { test } from "node:test";
import { payloadHash, type Mutation } from "../src/domain/contracts";
import { reconcileUnknownOperation, type ReconciliationDependencies } from "../src/services/reconcile";
import { deliverResultNotification, renderResultNotification } from "../src/services/notify";

const mutation: Mutation = {
  kind: "CREATE_ISSUE", repoId: "repo-1", owner: "acme", repo: "signal", title: "Ship release",
  body: "Ship release\n<!-- signal-operation:op-1 -->", assignees: [],
};

function deps(overrides: Partial<ReconciliationDependencies> = {}): ReconciliationDependencies {
  return {
    now: () => new Date("2026-09-12T12:00:00.000Z"),
    loadOperation: async () => ({ tenantId: "tenant-1", operationId: "op-1", version: 1, fencingToken: 1, state: "UNKNOWN", leaseExpiresAt: new Date("2026-09-12T11:59:00.000Z"), ownerAttemptId: "run-1", mutation, payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation }), expectedAuthorLogin: "signal-app[bot]" }),
    isOwningAttemptTerminal: async () => true,
    transitionSendingToUnknown: async () => true,
    getRepository: async () => ({ id: "repo-1", owner: "acme", repo: "signal" }),
    listIssues: async () => [{ id: "100", url: "https://github.com/acme/signal/issues/9", body: mutation.body, title: mutation.title, issueNumber: 9, authorLogin: "signal-app[bot]" }],
    listComments: async () => [],
    recordSuccess: async () => ({ jobId: "notify-1" }),
    recordUnresolved: async () => undefined,
    ...overrides,
  };
}

test("reconciles one exact issue marker and enqueues only a Slack notification", async () => {
  let success: unknown;
  const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({ recordSuccess: async (input) => { success = input; return { jobId: "notify-1" }; } }));
  assert.deepEqual(result, { state: "SUCCEEDED", externalId: "100", externalUrl: "https://github.com/acme/signal/issues/9", jobId: "notify-1" });
  assert.deepEqual(success, { tenantId: "tenant-1", operationId: "op-1", ownerAttemptId: "run-1", fencingToken: 1, externalId: "100", externalUrl: "https://github.com/acme/signal/issues/9", externalIssueNumber: 9 });
});

test("never reads or reposts while the owning attempt is active", async () => {
  let reads = 0;
  const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({ loadOperation: async () => ({ ...await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" }), state: "SENDING", leaseExpiresAt: new Date("2026-09-12T12:30:00.000Z") }), listIssues: async () => { reads += 1; return []; } }));
  assert.deepEqual(result, { state: "UNKNOWN", reason: "active_attempt" });
  assert.equal(reads, 0);
});

test("leaves absence and multiple matches UNKNOWN without sending", async () => {
  const notes: string[] = [];
  const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({ listIssues: async () => [], recordUnresolved: async (input) => { notes.push(input.errorCode); } }));
  assert.deepEqual(result, { state: "UNKNOWN", reason: "not_found" });
  assert.deepEqual(notes, ["reconcile_not_found"]);
});

test("result notifications contain no mutation payload and retry only Slack", async () => {
  let sent: unknown;
  await deliverResultNotification({ channelId: "C1", messageTs: "1710000000.000001", text: "ignored" }, { state: "UNKNOWN", action: "CREATE_ISSUE", errorCode: "reconcile_not_found", resolutionNote: "marker not found" }, { updateMessage: async (input) => { sent = input; } });
  assert.deepEqual(sent, { channelId: "C1", messageTs: "1710000000.000001", text: "Signal needs reconciliation before any further GitHub action. No matching operation marker was found; manual review is required." });
  assert.doesNotMatch(renderResultNotification({ state: "SUCCEEDED", action: "CREATE_ISSUE", externalUrl: "https://github.com/acme/signal/issues/1" }), /title|body|prompt/i);
});

for (const state of ["SENDING", "UNKNOWN"] as const) {
  test(`${state} cannot reconcile while leased or while its owner can still run`, async () => {
    for (const activeLease of [true, false]) {
      let reads = 0;
      let transitions = 0;
      const operation = await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" });
      assert.ok(operation);
      const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
        loadOperation: async () => ({ ...operation, state, leaseExpiresAt: new Date(activeLease ? "2026-09-12T12:01:00.000Z" : "2026-09-12T11:59:00.000Z") }),
        isOwningAttemptTerminal: async () => activeLease,
        transitionSendingToUnknown: async () => { transitions += 1; return true; },
        listIssues: async () => { reads += 1; return []; },
      }));
      assert.deepEqual(result, { state: "UNKNOWN", reason: "active_attempt" });
      assert.equal(reads, 0);
      assert.equal(transitions, 0);
    }
  });
}

test("missing ownership evidence and a failed terminality read cannot authorize reconciliation", async () => {
  const operation = await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" });
  assert.ok(operation);
  for (const change of [{ ownerAttemptId: null }, { leaseExpiresAt: null }, { payloadHash: "f".repeat(64) }, { operationId: "other-operation" }]) {
    let reads = 0;
    const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
      loadOperation: async () => ({ ...operation, ...change }),
      listIssues: async () => { reads += 1; return []; },
    }));
    assert.deepEqual(result, { state: "UNKNOWN", reason: "incomplete" });
    assert.equal(reads, 0);
  }
  const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({ isOwningAttemptTerminal: async () => { throw new Error("provider unavailable"); } }));
  assert.deepEqual(result, { state: "UNKNOWN", reason: "active_attempt" });
});

test("expired sending recovery preserves its fence and requires the transition before read-back", async () => {
  const operation = await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" });
  assert.ok(operation);
  let transitioned: unknown;
  let reads = 0;
  const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
    loadOperation: async () => ({ ...operation, state: "SENDING" }),
    transitionSendingToUnknown: async (input) => { transitioned = input; return false; },
    listIssues: async () => { reads += 1; return []; },
  }));
  assert.deepEqual(transitioned, { tenantId: "tenant-1", operationId: "op-1", ownerAttemptId: "run-1", fencingToken: 1, errorCode: "github_unknown" });
  assert.deepEqual(result, { state: "UNKNOWN", reason: "active_attempt" });
  assert.equal(reads, 0);
});

test("a second marker or altered marker payload remains ambiguous even with one exact match", async () => {
  const records = await deps().listIssues({ owner: "acme", repo: "signal" });
  const exact = records[0];
  assert.ok(exact);
  for (const list of [[exact, { ...exact, id: "101", body: `${exact.body}\nChanged` }], [{ ...exact, authorLogin: "someone-else" }], [{ ...exact, body: `${exact.body}\nChanged` }]]) {
    let settled = 0;
    const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
      listIssues: async () => list,
      recordSuccess: async () => { settled += 1; return { jobId: "n" }; },
    }));
    assert.deepEqual(result, { state: "UNKNOWN", reason: "ambiguous" });
    assert.equal(settled, 0);
  }
});

test("reused repository coordinates and incomplete pagination cannot settle an uncertain write", async () => {
  let reads = 0;
  const moved = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
    getRepository: async () => ({ id: "replacement-repository", owner: "acme", repo: "signal" }),
    listIssues: async () => { reads += 1; return []; },
  }));
  assert.deepEqual(moved, { state: "UNKNOWN", reason: "incomplete" });
  assert.equal(reads, 0);
  const incomplete = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({ listIssues: async () => { throw new Error("page limit"); } }));
  assert.deepEqual(incomplete, { state: "UNKNOWN", reason: "unavailable" });
});

test("comment reconciliation validates the parent issue and canonical comment URL", async () => {
  const comment: Mutation = { kind: "ADD_PROGRESS_COMMENT", repoId: "repo-1", owner: "acme", repo: "signal", issueId: "100", issueNumber: 9, body: mutation.body };
  const operation = await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" });
  assert.ok(operation);
  const commentDeps = deps({
    loadOperation: async () => ({ ...operation, mutation: comment, payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation: comment }) }),
    listComments: async () => [{ id: "55", url: "https://github.com/acme/signal/issues/9#issuecomment-55", body: comment.body, authorLogin: "signal-app[bot]", issueId: "100", issueNumber: 9 }],
  });
  assert.equal((await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, commentDeps)).state, "SUCCEEDED");
  for (const override of [{ issueId: "other" }, { url: "https://github.com/other/repository/issues/9#issuecomment-55" }, { url: "https://github.com/acme/signal/issues/9#issuecomment-56" }]) {
    const records = await commentDeps.listComments({ owner: "acme", repo: "signal", issueNumber: 9 });
    const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, { ...commentDeps, listComments: async () => [{ ...records[0]!, ...override }] });
    assert.deepEqual(result, { state: "UNKNOWN", reason: "ambiguous" });
  }
});

test("reconciliation rejects malformed external identities even when marker and body match", async () => {
  const [exact] = await deps().listIssues({ owner: "acme", repo: "signal" });
  assert.ok(exact);
  for (const change of [
    { id: "" }, { id: "00100" }, { id: "100x" }, { id: "9007199254740992" },
    { issueNumber: 0, url: "https://github.com/acme/signal/issues/0" },
    { issueNumber: undefined, url: "https://github.com/acme/signal/issues/undefined" },
  ]) {
    let successes = 0;
    const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
      listIssues: async () => [{ ...exact, ...change }],
      recordSuccess: async () => { successes += 1; return { jobId: "n" }; },
    }));
    assert.deepEqual(result, { state: "UNKNOWN", reason: "ambiguous" });
    assert.equal(successes, 0);
  }
});

test("reconciliation validates exact persisted bytes and a single own marker before reading", async () => {
  const operation = await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" });
  assert.ok(operation);
  for (const changed of [
    { ...mutation, body: `${mutation.body}\n` },
    { ...mutation, body: `${mutation.body}\n<!-- signal-operation:op-1 -->` },
    { ...mutation, body: `${mutation.body}\n<!-- signal-operation:other -->` },
    { ...mutation, title: " Ship release " },
    { ...mutation, body: mutation.body.replaceAll("\n", "\r\n") },
  ]) {
    let reads = 0;
    const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
      loadOperation: async () => ({ ...operation, mutation: changed }),
      listIssues: async () => { reads += 1; return []; },
    }));
    assert.deepEqual(result, { state: "UNKNOWN", reason: "incomplete" });
    assert.equal(reads, 0);
  }
});

test("missing expected App author and invalid clocks cannot authorize reconciliation", async () => {
  const operation = await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" });
  assert.ok(operation);
  for (const override of [
    { loadOperation: async () => ({ ...operation, expectedAuthorLogin: "" }) },
    { loadOperation: async () => ({ ...operation, expectedAuthorLogin: "human-user" }) },
    { now: () => new Date(NaN) },
    { loadOperation: async () => ({ ...operation, leaseExpiresAt: new Date(NaN) }) },
  ]) {
    let reads = 0;
    const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({ ...override, listIssues: async () => { reads += 1; return []; } }));
    assert.deepEqual(result, { state: "UNKNOWN", reason: "incomplete" });
    assert.equal(reads, 0);
  }
});

test("read-back success persists observed assignees including a dropped approved assignment", async () => {
  const operation = await deps().loadOperation({ tenantId: "tenant-1", operationId: "op-1" });
  assert.ok(operation);
  const assignedMutation: Mutation = { ...mutation, assignees: ["alice"] };
  const [exact] = await deps().listIssues({ owner: "acme", repo: "signal" });
  assert.ok(exact);
  for (const [assignees, mismatch] of [[[], true], [["bob"], true], [["Alice"], false]] as const) {
    let saved: Parameters<ReconciliationDependencies["recordSuccess"]>[0] | undefined;
    const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
      loadOperation: async () => ({ ...operation, mutation: assignedMutation, payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation: assignedMutation }) }),
      listIssues: async () => [{ ...exact, assignees: [...assignees] }],
      recordSuccess: async (input) => { saved = input; return { jobId: "n" }; },
    }));
    assert.equal(result.state, "SUCCEEDED");
    assert.deepEqual(saved?.actualAssignees, assignees);
    assert.equal(saved?.assigneeMismatch, mismatch);
    if (result.state === "SUCCEEDED") {
      assert.deepEqual(result.actualAssignees, assignees);
      assert.equal(result.assigneeMismatch, mismatch);
    }
  }
});

test("absent assignee evidence stays absent instead of becoming an empty assignment", async () => {
  let saved: Parameters<ReconciliationDependencies["recordSuccess"]>[0] | undefined;
  const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
    recordSuccess: async (input) => { saved = input; return { jobId: "n" }; },
  }));
  assert.equal(result.state, "SUCCEEDED");
  assert.equal(saved?.actualAssignees, undefined);
  assert.equal(saved?.assigneeMismatch, undefined);
  if (result.state === "SUCCEEDED") assert.equal(result.actualAssignees, undefined);
});

test("a lost reconciliation success fence never returns success", async () => {
  const result = await reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({ recordSuccess: async () => null }));
  assert.deepEqual(result, { state: "UNKNOWN", reason: "incomplete" });
});

test("reconciliation persistence errors expose no database detail", async () => {
  await assert.rejects(reconcileUnknownOperation({ tenantId: "tenant-1", operationId: "op-1" }, deps({
    recordSuccess: async () => { throw new Error("private synthetic query content"); },
  })), (error: unknown) => error instanceof Error && error.message === "reconciliation_persistence_failed");
});

const notificationContext = {
  tenantId: "tenant-1", operationId: "op-1", proposalId: "proposal-1", channelId: "C1", messageTs: "1710000000.000001",
};

test("result updates require matching complete operation, proposal, tenant and destination context", async () => {
  for (const change of [
    { tenantId: "tenant-2" }, { operationId: "op-2" }, { proposalId: "proposal-2" },
    { channelId: "C2" }, { messageTs: "1710000000.000002" }, { proposalId: "" },
  ]) {
    let sent = 0;
    await assert.rejects(deliverResultNotification(
      { channelId: "C1", messageTs: "1710000000.000001", text: "ignored", context: notificationContext },
      { state: "SUCCEEDED", action: "CREATE_ISSUE", context: { ...notificationContext, ...change } },
      { updateMessage: async () => { sent += 1; } },
    ), /notification_context_invalid/);
    assert.equal(sent, 0);
  }
});

test("a partially upgraded notification caller cannot omit one side of the binding", async () => {
  for (const targetHasContext of [true, false]) {
    let sent = 0;
    await assert.rejects(deliverResultNotification(
      { channelId: "C1", messageTs: "1710000000.000001", text: "ignored", ...(targetHasContext ? { context: notificationContext } : {}) },
      { state: "UNKNOWN", action: "CREATE_ISSUE", ...(!targetHasContext ? { context: notificationContext } : {}) },
      { updateMessage: async () => { sent += 1; } },
    ), /notification_context_invalid/);
    assert.equal(sent, 0);
  }
});

test("notification retries update the same exact message and never forward mutation content", async () => {
  const calls: unknown[] = [];
  const input = { channelId: "C1", messageTs: "1710000000.000001", text: "private synthetic input", body: "private synthetic body", context: notificationContext };
  const operation = { state: "SUCCEEDED" as const, action: "CREATE_ISSUE" as const, externalUrl: "https://github.com/acme/signal/issues/9", context: notificationContext };
  const client = { updateMessage: async (value: unknown) => { calls.push(value); if (calls.length === 1) throw new Error("private synthetic transport body"); } };
  await assert.rejects(deliverResultNotification(input, operation, client), (error: unknown) => error instanceof Error && error.message === "notification_delivery_failed");
  await deliverResultNotification(input, operation, client);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(Object.keys(calls[1] as object).sort(), ["channelId", "messageTs", "text"]);
  assert.doesNotMatch(JSON.stringify(calls), /private synthetic/);
});

test("result text surfaces observed assignee mismatch and never invents an empty assignment", () => {
  const base = { state: "SUCCEEDED" as const, action: "CREATE_ISSUE" as const, externalUrl: "https://github.com/acme/signal/issues/9" };
  assert.match(renderResultNotification({ ...base, actualAssignees: [], assigneeMismatch: true }), /assignees: none.*differ from the approved proposal/i);
  assert.match(renderResultNotification({ ...base, actualAssignees: ["alice"], assigneeMismatch: false }), /assignees: alice/i);
  assert.match(renderResultNotification(base), /assignee result unavailable/i);
  assert.doesNotMatch(renderResultNotification(base), /assignees: none/i);
});

test("result text excludes arbitrary resolution text, error detail and unsafe URLs", () => {
  for (const operation of [
    { state: "UNKNOWN" as const, action: "CREATE_ISSUE" as const, resolutionNote: "private synthetic mutation body <!channel>" },
    { state: "FAILED" as const, action: "CREATE_ISSUE" as const, errorCode: "private synthetic mutation body <!channel>" },
    { state: "SUCCEEDED" as const, action: "CREATE_ISSUE" as const, externalUrl: "https://github.com/acme/signal/issues/9?private=synthetic<!channel>" },
  ]) {
    assert.doesNotMatch(renderResultNotification(operation), /private|synthetic|<!channel>/);
  }
});
