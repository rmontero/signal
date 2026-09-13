import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { TriggerRunState } from "../adapters/trigger-run-status";
import { decideOutboxRecovery } from "../services/outbox-policy";
import type { SignalDb } from "./client";
import { operations, outbox, proposals, tenants } from "./schema";

export type OutboxExecutionClaim = { tenantId: string; jobId: string; taskId: string; runId: string; fencingToken: number };
export type OutboxRecoveryCandidate = OutboxExecutionClaim & { retryGeneration: number };
const activeTenant = sql`exists (select 1 from ${tenants} where ${tenants.id} = ${outbox.tenantId} and ${tenants.active} = true)`;
const expiredExecution = sql`coalesce(${outbox.executionLeaseExpiresAt}, coalesce(${outbox.dispatchedAt}, ${outbox.createdAt}) + interval '5 minutes') <= now()`;

export async function claimOutboxExecution(db: SignalDb, input: Omit<OutboxExecutionClaim, "fencingToken">): Promise<OutboxExecutionClaim | null> {
  if (!input.runId.trim() || input.runId !== input.runId.trim()) return null;
  const [claimed] = await db.update(outbox).set({
    executionState: "RUNNING", executionOwnerRunId: input.runId, triggerRunId: input.runId,
    executionFencingToken: sql`${outbox.executionFencingToken} + 1`,
    executionLeaseExpiresAt: sql`now() + interval '5 minutes'`, lastErrorCode: null,
  }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, input.taskId),
    eq(outbox.executionState, "READY"), sql`${outbox.nextAttemptAt} <= now()`, activeTenant,
    sql`(${outbox.triggerRunId} is null or ${outbox.triggerRunId} = ${input.runId})`,
  )).returning({ fencingToken: outbox.executionFencingToken });
  return claimed ? { ...input, fencingToken: claimed.fencingToken } : null;
}

export async function finishOutboxExecution(db: SignalDb, input: OutboxExecutionClaim & { state: "SUCCEEDED" | "FAILED" | "BLOCKED"; errorCode?: string }): Promise<boolean> {
  const [changed] = await db.update(outbox).set({
    executionState: input.state,
    // Retain a failed owner's lease until the recovery sweep confirms finality.
    ...(input.state !== "FAILED" ? { executionLeaseExpiresAt: null } : {}),
    lastErrorCode: input.errorCode && /^[a-z0-9_]{1,80}$/.test(input.errorCode) ? input.errorCode : null,
  }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, input.taskId),
    eq(outbox.executionState, "RUNNING"), eq(outbox.executionOwnerRunId, input.runId),
    eq(outbox.executionFencingToken, input.fencingToken), sql`${outbox.executionLeaseExpiresAt} > now()`,
  )).returning({ id: outbox.id });
  return Boolean(changed);
}

export async function listRecoverableOutboxExecutions(db: SignalDb, limit = 20): Promise<OutboxRecoveryCandidate[]> {
  const rows = await db.select({ tenantId: outbox.tenantId, jobId: outbox.id, taskId: outbox.taskId,
    runId: outbox.triggerRunId, fencingToken: outbox.executionFencingToken, retryGeneration: outbox.retryGeneration,
  }).from(outbox).where(and(activeTenant, sql`${outbox.triggerRunId} is not null`,
    sql`${outbox.executionState} in ('READY','RUNNING','FAILED')`, expiredExecution, sql`${outbox.nextAttemptAt} <= now()`,
  )).orderBy(outbox.createdAt).limit(Math.min(Math.max(1, limit), 100));
  return rows.filter((row): row is OutboxRecoveryCandidate => row.runId !== null);
}

/** Provider status is read outside this transaction; every local fact is fenced again here. */
export async function recoverOutboxExecution(db: SignalDb, input: OutboxRecoveryCandidate, runState: TriggerRunState): Promise<"wait" | "retry" | "settle" | "reconcile" | "block"> {
  if (runState === null || runState === "active") return "wait";
  return db.transaction(async (tx) => {
    // Other proposal/operation writers lock the tenant first; do not invert that order.
    const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, input.tenantId), eq(tenants.active, true))).for("update", { skipLocked: true });
    if (!tenant) return "wait";
    const [job] = await tx.select().from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId),
      eq(outbox.taskId, input.taskId), eq(outbox.triggerRunId, input.runId), eq(outbox.executionFencingToken, input.fencingToken),
      eq(outbox.retryGeneration, input.retryGeneration), activeTenant, expiredExecution,
    )).for("update", { skipLocked: true });
    if (!job) return "wait";
    const [operation] = job.operationId ? await tx.select().from(operations).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, job.operationId))).for("update") : [];
    const [proposal] = job.proposalId ? await tx.select().from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, job.proposalId))).for("update") : [];
    const decision = decideOutboxRecovery({ taskId: job.taskId, executionState: job.executionState, runState,
      leaseExpired: true, retryGeneration: job.retryGeneration, operationState: operation?.state,
      notificationState: proposal?.notificationState,
    });
    if (decision === "wait") return decision;
    if (decision === "reconcile" && operation) {
      const [existing] = await tx.select({ id: outbox.id }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.operationId, operation.id), eq(outbox.taskId, "signal.reconcile-operation"))).limit(1);
      if (!existing) await tx.insert(outbox).values({ tenantId: input.tenantId, id: randomUUID(), taskId: "signal.reconcile-operation", operationId: operation.id });
    }
    if (decision === "retry") {
      await tx.update(outbox).set({ dispatchState: "PENDING", executionState: "READY", triggerRunId: null,
        executionOwnerRunId: null, executionFencingToken: sql`${outbox.executionFencingToken} + 1`,
        executionLeaseExpiresAt: null, leaseExpiresAt: null, dispatchedAt: null,
        retryGeneration: job.retryGeneration + 1, nextAttemptAt: sql`now() + (${30 * 2 ** job.retryGeneration} * interval '1 second')`, lastErrorCode: "safe_retry_scheduled",
      }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
    } else {
      await tx.update(outbox).set({ executionState: decision === "block" ? "BLOCKED" : "SUCCEEDED", executionLeaseExpiresAt: null,
        lastErrorCode: decision === "block" ? "manual_recovery_required" : null,
      }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
      if (proposal && ["SENDING", "UNKNOWN"].includes(proposal.notificationState)) {
        await tx.update(proposals).set({ notificationState: "UNKNOWN" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, proposal.id)));
      }
    }
    return decision;
  });
}
