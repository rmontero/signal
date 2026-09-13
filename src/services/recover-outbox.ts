import type { SignalDb } from "../db/client";
import { enqueueExpiredOperationRecovery, listExpiredOperationsWithoutRecovery, listPendingOutboxJobs } from "../db/repositories";
import { dispatchStoredOutboxJob } from "../trigger/outbox";
import { listRecoverableOutboxExecutions, recoverOutboxExecution } from "../db/outbox-execution";
import { readTriggerRunState } from "../adapters/trigger-run-status";

/** Shared bounded recovery entrypoint for Trigger schedules and authenticated maintenance. */
export async function recoverOutbox(db: SignalDb, limit = 20, options: { signal?: AbortSignal; budgetMs?: number } = {}) {
  const started = performance.now();
  const budgetMs = Math.min(Math.max(options.budgetMs ?? 45_000, 1), 45_000);
  const exhausted = () => options.signal?.aborted || performance.now() - started >= budgetMs;
  let retried = 0;
  let settled = 0;
  let blocked = 0;
  const executions = await listRecoverableOutboxExecutions(db, limit);
  for (const execution of executions) {
    if (exhausted()) break;
    const runState = await readTriggerRunState(execution);
    const decision = await recoverOutboxExecution(db, execution, runState);
    if (decision === "retry") retried += 1;
    else if (decision === "block") blocked += 1;
    else if (decision === "settle" || decision === "reconcile") settled += 1;
  }
  const expired = exhausted() ? [] : await listExpiredOperationsWithoutRecovery(db, limit);
  let recoveryQueued = 0;
  for (const operation of expired) {
    if (exhausted()) break;
    if (await enqueueExpiredOperationRecovery(db, operation)) recoveryQueued += 1;
  }
  const jobs = exhausted() ? [] : await listPendingOutboxJobs(db, limit);
  let dispatched = 0;
  for (const job of jobs) {
    if (exhausted()) break;
    try {
      if (await dispatchStoredOutboxJob(db, { ...job, schemaVersion: 1 })) dispatched += 1;
    } catch { /* The durable job and stable key remain available for the next sweep. */ }
  }
  return { inspected: jobs.length, dispatched, recoveryQueued, retried, settled, blocked };
}
