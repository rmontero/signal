import { runs } from "@trigger.dev/sdk";

export type TriggerRunStatusInput = {
  runId: string;
  tenantId: string;
  jobId: string;
  taskId: string;
};

export type RetrieveTriggerRun = (runId: string) => Promise<unknown>;

const RETRIEVE_TIMEOUT_MS = 5_000;
const FINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELED"]);

const defaultRetrieveRun: RetrieveTriggerRun = (runId) =>
  runs.retrieve(runId, { retry: { maxAttempts: 1 } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyTerminalAttempts(run: Record<string, unknown>): boolean {
  if (!("attempts" in run)) return true;
  if (!Array.isArray(run.attempts)) return false;
  return run.attempts.every((attempt) => {
    if (!isRecord(attempt) || typeof attempt.status !== "string") return false;
    return TERMINAL_ATTEMPT_STATUSES.has(attempt.status);
  });
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

export async function confirmTerminalTriggerRun(
  input: TriggerRunStatusInput,
  retrieveRun: RetrieveTriggerRun = defaultRetrieveRun,
): Promise<boolean> {
  if (!input.runId || !input.tenantId || !input.jobId || !input.taskId) return false;

  try {
    const retrieved = await retrieveWithinDeadline(retrieveRun, input.runId);
    if (!isRecord(retrieved) || !isRecord(retrieved.payload)) return false;

    return (
      retrieved.id === input.runId &&
      retrieved.taskIdentifier === input.taskId &&
      retrieved.payload.tenantId === input.tenantId &&
      retrieved.payload.jobId === input.jobId &&
      retrieved.payload.schemaVersion === 1 &&
      typeof retrieved.status === "string" &&
      FINAL_RUN_STATUSES.has(retrieved.status) &&
      retrieved.isQueued === false &&
      retrieved.isExecuting === false &&
      retrieved.isWaiting === false &&
      hasOnlyTerminalAttempts(retrieved)
    );
  } catch {
    return false;
  }
}
