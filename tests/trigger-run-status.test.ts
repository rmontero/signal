import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmTerminalTriggerRun } from "../src/adapters/trigger-run-status";

const input = {
  runId: "run_signal_1",
  tenantId: "tenant_1",
  jobId: "job_1",
  taskId: "signal.execute-operation",
};

function retrievedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: input.runId,
    taskIdentifier: input.taskId,
    payload: { tenantId: input.tenantId, jobId: input.jobId, schemaVersion: 1 },
    status: "COMPLETED",
    isQueued: false,
    isExecuting: false,
    isWaiting: false,
    attempts: [],
    ...overrides,
  };
}

test("accepts a matching run in every final API-schema status", async () => {
  const finalStatuses = ["COMPLETED", "CANCELED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"];

  for (const status of finalStatuses) {
    assert.equal(
      await confirmTerminalTriggerRun(input, async () => retrievedRun({ status })),
      true,
      status,
    );
  }
});

test("rejects active, retrying, transitional, and unrecognized statuses", async () => {
  const statuses = ["QUEUED", "EXECUTING", "WAITING", "REATTEMPTING", "RETRYING", "FUTURE_STATUS"];

  for (const status of statuses) {
    assert.equal(
      await confirmTerminalTriggerRun(input, async () => retrievedRun({ status })),
      false,
      status,
    );
  }
});

test("rejects a final status when any active run flag contradicts finality", async () => {
  for (const flag of ["isQueued", "isExecuting", "isWaiting"]) {
    assert.equal(
      await confirmTerminalTriggerRun(input, async () => retrievedRun({ [flag]: true })),
      false,
      flag,
    );
  }
});

test("rejects a final run with an ongoing automatic attempt", async () => {
  const attempt = {
    id: "attempt_1",
    status: "EXECUTING",
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:01.000Z",
    startedAt: "2026-09-12T10:00:01.000Z",
  };

  assert.equal(await confirmTerminalTriggerRun(input, async () => retrievedRun({ attempts: [attempt] })), false);
});

test("accepts a final run whose known attempts are all terminal", async () => {
  const attempts = [
    { id: "attempt_1", status: "FAILED", createdAt: "2026-09-12T10:00:00.000Z", updatedAt: "2026-09-12T10:00:01.000Z" },
    { id: "attempt_2", status: "COMPLETED", createdAt: "2026-09-12T10:00:02.000Z", updatedAt: "2026-09-12T10:00:03.000Z" },
  ];

  assert.equal(await confirmTerminalTriggerRun(input, async () => retrievedRun({ attempts })), true);
});

test("rejects missing or mismatched run identity and payload", async () => {
  const cases = [
    { id: "run_other" },
    { taskIdentifier: "signal.other-task" },
    { payload: { tenantId: "tenant_other", jobId: input.jobId, schemaVersion: 1 } },
    { payload: { tenantId: input.tenantId, jobId: "job_other", schemaVersion: 1 } },
    { payload: { tenantId: input.tenantId, jobId: input.jobId, schemaVersion: 2 } },
    { payload: { tenantId: input.tenantId, schemaVersion: 1 } },
  ];

  for (const overrides of cases) {
    assert.equal(await confirmTerminalTriggerRun(input, async () => retrievedRun(overrides)), false, JSON.stringify(overrides));
  }
});

test("returns false for an unavailable API read without logging or retrying", async () => {
  let calls = 0;
  const originalError = console.error;
  let logged = false;
  console.error = () => { logged = true; };
  try {
    assert.equal(
      await confirmTerminalTriggerRun(input, async () => {
        calls += 1;
        throw new Error("provider unavailable");
      }),
      false,
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(calls, 1);
  assert.equal(logged, false);
});

test("returns false when the read exceeds the five-second deadline", async () => {
  const result = await confirmTerminalTriggerRun(input, () => new Promise(() => undefined));
  assert.equal(result, false);
});
