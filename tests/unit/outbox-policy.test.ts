import assert from "node:assert/strict";
import { test } from "node:test";
import { decideOutboxRecovery, type OutboxRecoveryInput } from "../../src/services/outbox-policy";

const failed: OutboxRecoveryInput = { taskId: "signal.analyze-thread", executionState: "FAILED", runState: "failed", leaseExpired: true, retryGeneration: 0 };

test("retries a terminated read-only job but not an active or unverified owner", () => {
  assert.equal(decideOutboxRecovery(failed), "retry");
  for (const runState of ["active", null] as const) assert.equal(decideOutboxRecovery({ ...failed, runState }), "wait");
  assert.equal(decideOutboxRecovery({ ...failed, leaseExpired: false }), "wait");
});

test("completed jobs are never restarted and retry exhaustion blocks", () => {
  for (const executionState of ["SUCCEEDED", "BLOCKED"]) assert.equal(decideOutboxRecovery({ ...failed, executionState }), "wait");
  assert.equal(decideOutboxRecovery({ ...failed, retryGeneration: 3 }), "block");
});

test("uncertain GitHub operations route only to reconciliation", () => {
  for (const operationState of ["SENDING", "UNKNOWN"]) {
    assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.execute-operation", operationState }), "reconcile");
    assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.execute-operation", operationState, runState: "active" }), "wait");
  }
  for (const operationState of ["SUCCEEDED", "FAILED", "STALE"]) assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.execute-operation", operationState }), "settle");
  assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.execute-operation", operationState: "READY" }), "retry");
  assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.execute-operation" }), "block");
});

test("Slack retry never repeats a possibly delivered initial proposal card", () => {
  for (const notificationState of ["SENDING", "UNKNOWN"]) assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.notify-slack", notificationState }), "block");
  assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.notify-slack", notificationState: "SENT" }), "settle");
  assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.notify-slack", notificationState: "PENDING" }), "retry");
  assert.equal(decideOutboxRecovery({ ...failed, taskId: "signal.notify-slack" }), "retry");
  assert.equal(decideOutboxRecovery({ ...failed, taskId: "unregistered-task" }), "block");
});
