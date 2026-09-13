import type { SignalDb } from "../db/client";
import { claimOutboxDispatch, markOutboxDispatched, releaseOutboxDispatch } from "../db/repositories";
import type { TaskInput } from "../domain/contracts";
import { dispatchOutboxJob } from "./dispatch";

/** Commit the claim before enqueueing, then fence the acknowledgment to that claim. */
export async function dispatchStoredOutboxJob(
  db: SignalDb,
  input: TaskInput & { taskId: string },
  dispatch = dispatchOutboxJob,
): Promise<boolean> {
  const claim = await claimOutboxDispatch(db, input);
  if (!claim) return false;
  try {
    const result = await dispatch({ ...input, retryGeneration: claim.retryGeneration });
    if (!result.dispatched || !result.triggerRunId) {
      await releaseOutboxDispatch(db, claim);
      return false;
    }
    return await markOutboxDispatched(db, { ...claim, triggerRunId: result.triggerRunId });
  } catch (error) {
    // An uncertain enqueue is retried with the same global key, never a new job.
    await releaseOutboxDispatch(db, claim);
    throw error;
  }
}
