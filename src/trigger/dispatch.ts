import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { canonicalJson, TaskInputSchema, type TaskInput } from "../domain/contracts";

const TASK_IDS = new Set([
  "signal.observe-event",
  "signal.analyze-thread",
  "signal.execute-operation",
  "signal.reconcile-operation",
  "signal.notify-slack",
]);

type DispatchDependencies = {
  configured: () => boolean;
  createKey: (parts: string[]) => Promise<string>;
  trigger: (taskId: string, payload: TaskInput, key: string) => Promise<{ id: string }>;
  timeoutMs: number;
};
const defaults: DispatchDependencies = {
  configured: () => Boolean(process.env.TRIGGER_SECRET_KEY?.trim()),
  createKey: (parts) => idempotencyKeys.create(parts, { scope: "global" }),
  trigger: (taskId, payload, key) => tasks.trigger(taskId as never, payload, { idempotencyKey: key, ttl: "5m" }, { retry: { maxAttempts: 1 } }),
  timeoutMs: 10_000,
};

/** Dispatches a durable outbox job after its database transaction commits. */
export async function dispatchOutboxJob(input: TaskInput & { taskId: string; retryGeneration?: number }, dependencies: DispatchDependencies = defaults): Promise<{ dispatched: boolean; triggerRunId?: string }> {
  if (!TASK_IDS.has(input.taskId) || !dependencies.configured()) return { dispatched: false };
  const supplied = { tenantId: input.tenantId, jobId: input.jobId, schemaVersion: input.schemaVersion };
  const payload = TaskInputSchema.parse(supplied);
  if (canonicalJson(payload) !== canonicalJson(supplied) || !Number.isSafeInteger(input.retryGeneration ?? 0) || (input.retryGeneration ?? 0) < 0 || (input.retryGeneration ?? 0) > 3) throw new Error("dispatch_input_invalid");
  const keyParts = [input.tenantId, input.taskId, input.jobId];
  if (input.retryGeneration) keyParts.push(`retry:${input.retryGeneration}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const work = (async () => {
      const idempotencyKey = await dependencies.createKey(keyParts);
      if (timedOut) throw new Error("dispatch_unavailable");
      return dependencies.trigger(input.taskId, payload, idempotencyKey);
    })();
    // The SDK has no abort option here. Timeout means uncertain acceptance, not cancellation.
    const handle = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new Error("dispatch_unavailable")); }, dependencies.timeoutMs);
    })]);
    if (!handle.id?.trim() || handle.id !== handle.id.trim()) throw new Error("dispatch_unavailable");
    return { dispatched: true, triggerRunId: handle.id };
  } catch { throw new Error("dispatch_unavailable"); }
  finally { if (timer) clearTimeout(timer); }
}
