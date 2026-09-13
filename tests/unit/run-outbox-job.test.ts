import assert from "node:assert/strict";
import test from "node:test";
import { OutboxJobBlocked, runOutboxJob, type OutboxRuntime } from "../../src/trigger/run-outbox-job";
import type { SignalDb } from "../../src/db/client";

const payload = { tenantId: "tenant-runner", jobId: "job-runner", schemaVersion: 1 as const };
const execution = { taskId: "signal.observe-event", runId: "run-runner" };
const job = { ...payload, taskId: execution.taskId, inboxId: null, proposalId: null, operationId: null, observerEventId: "event-runner" };
function harness() {
  const states: string[] = [];
  let closed = 0;
  const runtime: OutboxRuntime = {
    connect: () => ({ db: {} as SignalDb, pool: { async end() { closed++; } } }),
    claim: async () => ({ ...payload, ...execution, fencingToken: 1 }),
    load: async () => job,
    finish: async (_db, input) => { states.push(input.state); return true; },
  };
  return { runtime, states, closed: () => closed };
}

test("outbox runner owns and validates the durable job before invoking work", async () => {
  const h = harness();
  let called = 0;
  assert.deepEqual(await runOutboxJob(payload, execution, async ({ signal }) => { called++; assert.equal(signal.aborted, false); return { state: "done" }; }, h.runtime), { state: "done" });
  assert.equal(called, 1);
  assert.deepEqual(h.states, ["SUCCEEDED"]);
  assert.equal(h.closed(), 1);
  h.runtime.claim = async () => null;
  assert.deepEqual(await runOutboxJob(payload, execution, async () => { called++; return { state: "done" }; }, h.runtime), { state: "not_claimed" });
  assert.equal(called, 1);
});

test("outbox runner rejects wrong tenant and contradictory entity bindings before work", async () => {
  for (const badJob of [{ ...job, tenantId: "other" }, { ...job, operationId: "op" }, { ...job, observerEventId: null }, { ...job, taskId: "signal.analyze-thread" }]) {
    const h = harness();
    h.runtime.load = async () => badJob;
    assert.deepEqual(await runOutboxJob(payload, execution, async () => { throw new Error("must_not_run"); }, h.runtime), { state: "BLOCKED" });
    assert.deepEqual(h.states, ["BLOCKED"]);
  }
});

test("outbox runner sanitizes failures and distinguishes deliberate blocking", async () => {
  const h = harness();
  await assert.rejects(runOutboxJob(payload, execution, async () => { throw new Error("private fixture payload"); }, h.runtime), { message: "signal_job_failed" });
  assert.deepEqual(h.states, ["FAILED"]);
  assert.deepEqual(await runOutboxJob(payload, execution, async () => { throw new OutboxJobBlocked(); }, h.runtime), { state: "BLOCKED" });
  assert.equal(h.closed(), 2);
});

test("outbox runner never reports success after the completion fence is lost", async () => {
  const h = harness();
  h.runtime.finish = async () => false;
  await assert.rejects(runOutboxJob(payload, execution, async () => ({ state: "done" }), h.runtime), { message: "signal_job_failed" });
  assert.equal(h.closed(), 1);
});
