import assert from "node:assert/strict";
import test from "node:test";
import { dispatchOutboxJob } from "../../src/trigger/dispatch";

const input = { tenantId: "tenant-fixture", jobId: "job-fixture", taskId: "signal.observe-event", schemaVersion: 1 as const };
test("dispatch keys retain stable identity and change only for bounded recovery generations", async () => {
  const keys: string[][] = [];
  const payloads: unknown[] = [];
  const deps = { configured: () => true, timeoutMs: 1_000, createKey: async (parts: string[]) => { keys.push(parts); return "key"; }, trigger: async (_task: string, payload: unknown) => { payloads.push(payload); return { id: "run-fixture" }; } };
  await dispatchOutboxJob(input, deps);
  await dispatchOutboxJob({ ...input, retryGeneration: 0 }, deps);
  await dispatchOutboxJob({ ...input, retryGeneration: 1 }, deps);
  assert.deepEqual(keys[0], [input.tenantId, input.taskId, input.jobId]);
  assert.deepEqual(keys[0], keys[1]);
  assert.deepEqual(keys[2], [...keys[0], "retry:1"]);
  assert.deepEqual(payloads, Array(3).fill({ tenantId: input.tenantId, jobId: input.jobId, schemaVersion: 1 }));
  await assert.rejects(dispatchOutboxJob({ ...input, retryGeneration: 4 }, deps));
  await assert.rejects(dispatchOutboxJob({ ...input, tenantId: " tenant-fixture" }, deps));
  assert.equal(payloads.length, 3);
});
test("dispatch times out once with a sanitized uncertain result and never retries locally", async () => {
  let calls = 0;
  const deps = { configured: () => true, timeoutMs: 5, createKey: async () => "key", trigger: async () => { calls++; return new Promise<{ id: string }>(() => {}); } };
  await assert.rejects(dispatchOutboxJob(input, deps), { message: "dispatch_unavailable" });
  assert.equal(calls, 1);
  await assert.rejects(dispatchOutboxJob(input, { ...deps, trigger: async () => { throw new Error("private provider text"); } }), { message: "dispatch_unavailable" });
});
