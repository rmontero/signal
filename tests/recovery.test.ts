import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mutation } from "../src/domain/contracts";
import { reconcileUnknownOperation, type ReconciliationDependencies } from "../src/services/reconcile";
import { deliverResultNotification, renderResultNotification } from "../src/services/notify";

const mutation: Mutation = {
  kind: "CREATE_ISSUE", repoId: "repo-1", owner: "acme", repo: "signal", title: "Ship release",
  body: "Ship release\n<!-- signal-operation:op-1 -->", assignees: [],
};

function deps(overrides: Partial<ReconciliationDependencies> = {}): ReconciliationDependencies {
  return {
    now: () => new Date("2026-09-12T12:00:00.000Z"),
    loadOperation: async () => ({ tenantId: "tenant-1", operationId: "op-1", state: "UNKNOWN", leaseExpiresAt: null, ownerAttemptId: "attempt-1", mutation, payloadHash: "a".repeat(64), expectedAuthorLogin: "signal-app[bot]" }),
    isOwningAttemptTerminal: async () => true,
    transitionSendingToUnknown: async () => true,
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
  assert.deepEqual(success, { tenantId: "tenant-1", operationId: "op-1", externalId: "100", externalUrl: "https://github.com/acme/signal/issues/9" });
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
  await deliverResultNotification({ channelId: "C1", messageTs: "1710000000.000001", text: "ignored" }, { state: "UNKNOWN", action: "CREATE_ISSUE", resolutionNote: "marker not found" }, { updateMessage: async (input) => { sent = input; } });
  assert.deepEqual(sent, { channelId: "C1", messageTs: "1710000000.000001", text: "Signal needs reconciliation before any further GitHub action. marker not found" });
  assert.doesNotMatch(renderResultNotification({ state: "SUCCEEDED", action: "CREATE_ISSUE", externalUrl: "https://github.com/acme/signal/issues/1" }), /title|body|prompt/i);
});
