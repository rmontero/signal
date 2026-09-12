import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { TaskInput } from "../domain/contracts";

const TASK_IDS = new Set([
  "signal.observe-event",
  "signal.analyze-thread",
  "signal.execute-operation",
  "signal.reconcile-operation",
  "signal.notify-slack",
]);

/** Dispatches a durable outbox job after its database transaction commits. */
export async function dispatchOutboxJob(input: TaskInput & { taskId: string }): Promise<{ dispatched: boolean; triggerRunId?: string }> {
  if (!TASK_IDS.has(input.taskId) || !process.env.TRIGGER_SECRET_KEY?.trim()) return { dispatched: false };
  const idempotencyKey = await idempotencyKeys.create([input.tenantId, input.taskId, input.jobId], { scope: "global" });
  const handle = await tasks.trigger(input.taskId as never, { tenantId: input.tenantId, jobId: input.jobId, schemaVersion: 1 }, { idempotencyKey });
  return { dispatched: true, triggerRunId: handle.id };
}
