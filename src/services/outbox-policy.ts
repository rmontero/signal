import type { TriggerRunState } from "../adapters/trigger-run-status";

export type OutboxRecoveryInput = {
  taskId: string;
  executionState: string;
  runState: TriggerRunState;
  leaseExpired: boolean;
  retryGeneration: number;
  operationState?: string | null;
  notificationState?: string | null;
};
export type OutboxRecoveryDecision = "wait" | "retry" | "settle" | "reconcile" | "block";

export function decideOutboxRecovery(input: OutboxRecoveryInput): OutboxRecoveryDecision {
  if (["SUCCEEDED", "BLOCKED"].includes(input.executionState)) return "wait";
  if (!input.leaseExpired || input.runState === null || input.runState === "active") return "wait";
  if (!["READY", "RUNNING", "FAILED"].includes(input.executionState)) return "block";
  if (input.taskId === "signal.execute-operation") {
    if (["SENDING", "UNKNOWN"].includes(input.operationState ?? "")) return "reconcile";
    if (["SUCCEEDED", "FAILED", "STALE"].includes(input.operationState ?? "")) return "settle";
    if (input.operationState !== "READY") return "block";
  } else if (input.taskId === "signal.notify-slack") {
    if (["SENDING", "UNKNOWN"].includes(input.notificationState ?? "")) return "block";
    if (input.notificationState === "SENT") return "settle";
  } else if (!["signal.analyze-thread", "signal.observe-event", "signal.reconcile-operation"].includes(input.taskId)) return "block";
  return Number.isSafeInteger(input.retryGeneration) && input.retryGeneration >= 0 && input.retryGeneration < 3 ? "retry" : "block";
}
