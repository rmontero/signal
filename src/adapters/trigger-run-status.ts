import { runs } from "@trigger.dev/sdk";

export type TriggerRunStatusInput = {
  runId: string;
  tenantId: string;
  jobId: string;
  taskId: string;
};

export type RetrieveTriggerRun = (runId: string) => Promise<unknown>;

export type TriggerRunState = "active" | "succeeded" | "failed" | null;

const RETRIEVE_TIMEOUT_MS = 5_000;
const ACTIVE_RUN_STATUSES = new Set([
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "DELAYED",
]);
const FAILED_RUN_STATUSES = new Set([
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);
const KNOWN_ATTEMPT_STATUSES = new Set([
  "PENDING",
  "EXECUTING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELED"]);

const ACTIVE_FLAG_EXPECTATIONS: Record<
  string,
  { isQueued: boolean; isExecuting: boolean; isWaiting: boolean }
> = {
  PENDING_VERSION: { isQueued: false, isExecuting: false, isWaiting: false },
  QUEUED: { isQueued: true, isExecuting: false, isWaiting: false },
  DEQUEUED: { isQueued: false, isExecuting: false, isWaiting: false },
  EXECUTING: { isQueued: false, isExecuting: true, isWaiting: false },
  WAITING: { isQueued: false, isExecuting: false, isWaiting: true },
  DELAYED: { isQueued: false, isExecuting: false, isWaiting: false },
};

const defaultRetrieveRun: RetrieveTriggerRun = (runId) =>
  runs.retrieve(runId, { retry: { maxAttempts: 1 } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasMatchingIdentity(
  input: TriggerRunStatusInput,
  retrieved: Record<string, unknown>,
): boolean {
  return (
    isRecord(retrieved.payload) &&
    retrieved.id === input.runId &&
    retrieved.taskIdentifier === input.taskId &&
    retrieved.payload.tenantId === input.tenantId &&
    retrieved.payload.jobId === input.jobId &&
    retrieved.payload.schemaVersion === 1
  );
}

function hasKnownAttempts(run: Record<string, unknown>): boolean {
  if (!("attempts" in run)) return true;
  if (!Array.isArray(run.attempts)) return false;
  return run.attempts.every((attempt) => {
    return isRecord(attempt) &&
      typeof attempt.status === "string" &&
      KNOWN_ATTEMPT_STATUSES.has(attempt.status);
  });
}

function hasOnlyTerminalAttempts(run: Record<string, unknown>): boolean {
  if (!("attempts" in run)) return true;
  if (!Array.isArray(run.attempts)) return false;
  return run.attempts.every((attempt) => {
    if (!isRecord(attempt) || typeof attempt.status !== "string") return false;
    return TERMINAL_ATTEMPT_STATUSES.has(attempt.status);
  });
}

function hasConsistentActiveFlags(
  run: Record<string, unknown>,
  status: string,
): boolean {
  const expected = ACTIVE_FLAG_EXPECTATIONS[status];
  return expected !== undefined &&
    run.isQueued === expected.isQueued &&
    run.isExecuting === expected.isExecuting &&
    run.isWaiting === expected.isWaiting;
}

function hasNoActiveState(run: Record<string, unknown>): boolean {
  return run.isQueued === false && run.isExecuting === false && run.isWaiting === false;
}

async function retrieveWithinDeadline(
  retrieveRun: RetrieveTriggerRun,
  runId: string,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      retrieveRun(runId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Trigger run status read timed out")), RETRIEVE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readTriggerRunState(
  input: TriggerRunStatusInput,
  retrieveRun: RetrieveTriggerRun = defaultRetrieveRun,
): Promise<TriggerRunState> {
  if (!input.runId || !input.tenantId || !input.jobId || !input.taskId) return null;

  try {
    const retrieved = await retrieveWithinDeadline(retrieveRun, input.runId);
    if (!isRecord(retrieved) || !hasMatchingIdentity(input, retrieved)) return null;
    if (typeof retrieved.status !== "string") return null;

    if (retrieved.status === "COMPLETED") {
      return hasNoActiveState(retrieved) && hasOnlyTerminalAttempts(retrieved)
        ? "succeeded"
        : null;
    }

    if (FAILED_RUN_STATUSES.has(retrieved.status)) {
      return hasNoActiveState(retrieved) && hasOnlyTerminalAttempts(retrieved)
        ? "failed"
        : null;
    }

    if (ACTIVE_RUN_STATUSES.has(retrieved.status)) {
      return hasConsistentActiveFlags(retrieved, retrieved.status) && hasKnownAttempts(retrieved)
        ? "active"
        : null;
    }

    return null;
  } catch {
    return null;
  }
}

export async function confirmTerminalTriggerRun(
  input: TriggerRunStatusInput,
  retrieveRun: RetrieveTriggerRun = defaultRetrieveRun,
): Promise<boolean> {
  const state = await readTriggerRunState(input, retrieveRun);
  return state === "succeeded" || state === "failed";
}
