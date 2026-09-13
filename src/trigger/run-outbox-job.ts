import { createDb, type SignalDb } from "../db/client";
import { claimOutboxExecution, finishOutboxExecution, type OutboxExecutionClaim } from "../db/outbox-execution";
import { loadOutboxJob } from "../db/repositories";
import { TaskInputSchema, type TaskInput } from "../domain/contracts";

type Job = NonNullable<Awaited<ReturnType<typeof loadOutboxJob>>>;
export class OutboxJobBlocked extends Error {
  constructor() { super("signal_job_blocked"); }
}
export type OutboxJobResult = { state: string; [key: string]: string | number | boolean };
export type OutboxRuntime = {
  connect: () => { db: SignalDb; pool: { end(): Promise<void> } };
  claim: typeof claimOutboxExecution;
  load: typeof loadOutboxJob;
  finish: typeof finishOutboxExecution;
};
const runtime: OutboxRuntime = { connect: createDb, claim: claimOutboxExecution, load: loadOutboxJob, finish: finishOutboxExecution };

function validEntity(job: Job): boolean {
  const references = [job.inboxId, job.proposalId, job.operationId, job.observerEventId].filter(Boolean);
  if (references.length !== 1) return false;
  switch (job.taskId) {
    case "signal.analyze-thread": return Boolean(job.inboxId);
    case "signal.observe-event": return Boolean(job.observerEventId);
    case "signal.execute-operation":
    case "signal.reconcile-operation": return Boolean(job.operationId);
    case "signal.notify-slack": return Boolean(job.proposalId || job.operationId);
    default: return false;
  }
}

/** Own the durable job before any adapter work; never expose a caught payload/provider error. */
export async function runOutboxJob(
  input: TaskInput,
  execution: { taskId: string; runId: string },
  work: (context: { db: SignalDb; job: Job; signal: AbortSignal }) => Promise<OutboxJobResult>,
  dependencies: OutboxRuntime = runtime,
): Promise<OutboxJobResult> {
  let connection: ReturnType<OutboxRuntime["connect"]> | undefined;
  let claim: OutboxExecutionClaim | null = null;
  try {
    const payload = TaskInputSchema.parse(input);
    connection = dependencies.connect();
    claim = await dependencies.claim(connection.db, { ...payload, ...execution });
    if (!claim) return { state: "not_claimed" };
    const job = await dependencies.load(connection.db, { ...payload, taskId: execution.taskId });
    if (!job || !validEntity(job) || job.tenantId !== payload.tenantId || job.jobId !== payload.jobId || job.taskId !== execution.taskId) throw new OutboxJobBlocked();
    const result = await work({ db: connection.db, job, signal: AbortSignal.timeout(210_000) });
    const state = result.state === "BLOCKED" ? "BLOCKED" : "SUCCEEDED";
    if (!await dependencies.finish(connection.db, { ...claim, state })) throw new Error("completion_fence_lost");
    return result;
  } catch (error) {
    const blocked = error instanceof OutboxJobBlocked;
    if (connection && claim) {
      try { await dependencies.finish(connection.db, { ...claim, state: blocked ? "BLOCKED" : "FAILED", errorCode: blocked ? "job_blocked" : "job_failed" }); } catch { /* Lease and recorded owner retain recovery authority. */ }
    }
    if (blocked) return { state: "BLOCKED" };
    throw new Error("signal_job_failed");
  } finally {
    try { await connection?.pool.end(); } catch { /* No raw driver error is exposed to task logs. */ }
  }
}
