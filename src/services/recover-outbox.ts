import type { SignalDb } from "../db/client";
import { enqueueExpiredOperationRecovery, listExpiredOperationsWithoutRecovery, listPendingOutboxJobs } from "../db/repositories";
import { dispatchStoredOutboxJob } from "../trigger/outbox";

/** Shared bounded recovery entrypoint for Trigger schedules and authenticated maintenance. */
export async function recoverOutbox(db: SignalDb, limit = 20) {
  const expired = await listExpiredOperationsWithoutRecovery(db, limit);
  let recoveryQueued = 0;
  for (const operation of expired) {
    if (await enqueueExpiredOperationRecovery(db, operation)) recoveryQueued += 1;
  }
  const jobs = await listPendingOutboxJobs(db, limit);
  let dispatched = 0;
  for (const job of jobs) {
    try {
      if (await dispatchStoredOutboxJob(db, { ...job, schemaVersion: 1 })) dispatched += 1;
    } catch { /* The durable job and stable key remain available for the next sweep. */ }
  }
  return { inspected: jobs.length, dispatched, recoveryQueued };
}
