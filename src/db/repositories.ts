import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SignalDb } from "./client";
import { isUniqueViolation, PersistenceConflict } from "./errors";
import { audit, channelMappings, identityMappings, inbox, observedEvents, operations, outbox, proposals, snapshots, tenants, threads } from "./schema";
import { AcceptMentionSchema, type AcceptMention, canonicalJson, MutationSchema, ObserverEventSchema, type Mutation, type PersistedConversationRow, type PersistedObserverRow } from "../domain/contracts";
import type { UnknownOperation } from "../services/reconcile";
import type { ObserverEventInput } from "../domain/observer-events";

export { PersistenceConflict } from "./errors";
export { approveProposal, claimMutation, loadProposalForApproval, recordSlackReview, loadSlackReview, isNamedApprover, dismissProposal } from "./approval-persistence";
export { createProposal, persistAnalyzedProposal, loadInboxContext } from "./proposal-persistence";

export async function insertTenant(db: SignalDb, input: { tenantId: string; slackTeamId: string; configVersion?: number }): Promise<void> {
  await db.insert(tenants).values({ id: input.tenantId, slackTeamId: input.slackTeamId, configVersion: input.configVersion ?? 1 });
}

export async function resolveActiveSlackTenant(db: SignalDb, input: { slackTeamId: string }): Promise<string | null> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.slackTeamId, input.slackTeamId), eq(tenants.active, true))).limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

export async function insertChannelMapping(db: SignalDb, input: { tenantId: string; channelId: string; repositoryId: string; repositoryOwner: string; repositoryName: string; installationId: string; shared?: boolean }): Promise<void> {
  await db.insert(channelMappings).values({ ...input, shared: input.shared ?? false });
}

export async function resolveSlackObserverTenant(db: SignalDb, input: { slackTeamId: string; channelId: string }): Promise<string | null> {
  const rows = await db.selectDistinct({ tenantId: tenants.id }).from(tenants).innerJoin(channelMappings, and(
    eq(channelMappings.tenantId, tenants.id),
    eq(channelMappings.channelId, input.channelId),
    eq(channelMappings.enabled, true),
    eq(channelMappings.shared, false),
  )).where(and(eq(tenants.slackTeamId, input.slackTeamId), eq(tenants.active, true))).limit(2);
  return rows.length === 1 ? rows[0].tenantId : null;
}

export async function resolveGitHubObserverTenant(db: SignalDb, input: { repositoryId: string; installationId: string }): Promise<string | null> {
  const rows = await db.selectDistinct({ tenantId: tenants.id }).from(tenants).innerJoin(channelMappings, and(
    eq(channelMappings.tenantId, tenants.id),
    eq(channelMappings.repositoryId, input.repositoryId),
    eq(channelMappings.installationId, input.installationId),
    eq(channelMappings.enabled, true),
    eq(channelMappings.shared, false),
  )).where(eq(tenants.active, true)).limit(2);
  return rows.length === 1 ? rows[0].tenantId : null;
}

export async function insertThread(db: SignalDb, input: { tenantId: string; threadId?: string; channelId: string; threadTs: string }): Promise<string> {
  const id = input.threadId ?? randomUUID();
  await db.insert(threads).values({ tenantId: input.tenantId, id, channelId: input.channelId, threadTs: input.threadTs });
  return id;
}

export async function insertSnapshot(db: SignalDb, input: { tenantId: string; snapshotId?: string; threadId: string; content: unknown; snapshotHash: string; expiresAt: Date }): Promise<string> {
  const id = input.snapshotId ?? randomUUID();
  await db.insert(snapshots).values({ tenantId: input.tenantId, id, threadId: input.threadId, content: input.content, snapshotHash: input.snapshotHash, expiresAt: input.expiresAt });
  return id;
}

type SignalTransaction = Parameters<Parameters<SignalDb["transaction"]>[0]>[0];

async function lockIntakeScope(tx: SignalTransaction, input: { tenantId: string; channelId?: string | null; slackTeamId?: string; repositoryId?: string | null; installationId?: string | null; repositoryOwner?: string | null; repositoryName?: string | null }): Promise<void> {
  const [tenant] = await tx.select().from(tenants).where(and(eq(tenants.id, input.tenantId), eq(tenants.active, true))).for("update");
  if (!tenant || (input.slackTeamId !== undefined && tenant.slackTeamId !== input.slackTeamId)) throw new PersistenceConflict("Intake configuration is unavailable");
  const rows = await tx.select({ channelId: channelMappings.channelId }).from(channelMappings).where(and(
    eq(channelMappings.tenantId, input.tenantId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false),
    input.channelId ? eq(channelMappings.channelId, input.channelId) : and(eq(channelMappings.repositoryId, input.repositoryId ?? ""), eq(channelMappings.installationId, input.installationId ?? ""), eq(channelMappings.repositoryOwner, input.repositoryOwner ?? ""), eq(channelMappings.repositoryName, input.repositoryName ?? "")),
  )).limit(1).for("share");
  if (!rows[0]) throw new PersistenceConflict("Intake mapping is unavailable");
  if (!input.channelId) {
    const admitted = await tx.selectDistinct({ id: tenants.id }).from(tenants).innerJoin(channelMappings, and(eq(channelMappings.tenantId, tenants.id), eq(channelMappings.repositoryId, input.repositoryId ?? ""), eq(channelMappings.installationId, input.installationId ?? ""), eq(channelMappings.enabled, true), eq(channelMappings.shared, false))).where(eq(tenants.active, true)).limit(2);
    if (admitted.length !== 1 || admitted[0].id !== input.tenantId) throw new PersistenceConflict("Intake mapping is ambiguous");
  }
}

/** Match approval/proposal lock ordering before settling a result and releasing its thread. */
async function lockOperationScope(tx: SignalTransaction, input: { tenantId: string; operationId: string }): Promise<void> {
  const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).for("update");
  if (!tenant) throw new PersistenceConflict("Operation tenant is unavailable");
  const [parent] = await tx.select({ id: proposals.id, threadId: proposals.threadId }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.operationId, input.operationId))).limit(1);
  if (!parent) throw new PersistenceConflict("Operation proposal is unavailable");
  await tx.select({ id: threads.id }).from(threads).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, parent.threadId))).for("update");
  await tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, parent.id))).for("update");
}

export async function acceptMention(db: SignalDb, rawInput: AcceptMention): Promise<{ inboxId: string; jobId: string; duplicate: boolean }> {
  const input = AcceptMentionSchema.parse(rawInput);
  const inboxId = randomUUID();
  const jobId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await lockIntakeScope(tx, input);
      const existingThread = await tx.select({ id: threads.id }).from(threads).where(and(eq(threads.tenantId, input.tenantId), eq(threads.channelId, input.channelId), eq(threads.threadTs, input.threadTs))).limit(1);
      if (!existingThread[0]) await tx.insert(threads).values({ tenantId: input.tenantId, id: randomUUID(), channelId: input.channelId, threadTs: input.threadTs });
      await tx.insert(inbox).values({ tenantId: input.tenantId, id: inboxId, slackEventId: input.slackEventId, channelId: input.channelId, threadTs: input.threadTs, messageTs: input.messageTs, actorSlackId: input.actorSlackId });
      await tx.insert(outbox).values({ tenantId: input.tenantId, id: jobId, taskId: "signal.analyze-thread", inboxId });
    });
    return { inboxId, jobId, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.select({ inboxId: inbox.id }).from(inbox).where(and(eq(inbox.tenantId, input.tenantId), eq(inbox.slackEventId, input.slackEventId))).limit(1);
    if (!existing[0]) throw error;
    const existingJob = await db.select({ jobId: outbox.id }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.inboxId, existing[0].inboxId))).limit(1);
    if (!existingJob[0]) throw new Error("Inbox exists without its analysis outbox job");
    return { inboxId: existing[0].inboxId, jobId: existingJob[0].jobId, duplicate: true };
  }
}


export async function loadOutboxJob(db: SignalDb, input: { tenantId: string; jobId: string; taskId: string }): Promise<{ tenantId: string; jobId: string; taskId: string; inboxId: string | null; proposalId: string | null; operationId: string | null; observerEventId: string | null } | null> {
  const rows = await db.select({ tenantId: outbox.tenantId, jobId: outbox.id, taskId: outbox.taskId, inboxId: outbox.inboxId, proposalId: outbox.proposalId, operationId: outbox.operationId, observerEventId: outbox.observerEventId }).from(outbox).innerJoin(tenants, and(eq(tenants.id, outbox.tenantId), eq(tenants.active, true))).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, input.taskId))).limit(1);
  return rows[0] ?? null;
}

export async function listPendingOutboxJobs(db: SignalDb, limit = 20): Promise<Array<{ tenantId: string; jobId: string; taskId: string }>> {
  const rows = await db.select({ tenantId: outbox.tenantId, jobId: outbox.id, taskId: outbox.taskId }).from(outbox).innerJoin(tenants, and(eq(tenants.id, outbox.tenantId), eq(tenants.active, true))).where(and(eq(outbox.executionState, "READY"), sql`${outbox.nextAttemptAt} <= now()`, sql`(${outbox.dispatchState} = 'PENDING' or (${outbox.dispatchState} = 'CLAIMED' and ${outbox.leaseExpiresAt} <= now()))`)).orderBy(outbox.createdAt).limit(Math.min(Math.max(1, limit), 100));
  return rows;
}

export async function claimOutboxDispatch(db: SignalDb, input: { tenantId: string; jobId: string; taskId: string }): Promise<{ tenantId: string; jobId: string; taskId: string; claimAttempt: number; retryGeneration: number } | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ attempts: outbox.attempts, retryGeneration: outbox.retryGeneration }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, input.taskId), eq(outbox.executionState, "READY"), sql`${outbox.nextAttemptAt} <= now()`, sql`(${outbox.dispatchState} = 'PENDING' or (${outbox.dispatchState} = 'CLAIMED' and ${outbox.leaseExpiresAt} <= now()))`, sql`exists (select 1 from ${tenants} where ${tenants.id} = ${outbox.tenantId} and ${tenants.active} = true)`)).for("update", { skipLocked: true });
    if (!job) return null;
    const claimAttempt = job.attempts + 1;
    await tx.update(outbox).set({ dispatchState: "CLAIMED", attempts: claimAttempt, leaseExpiresAt: sql`now() + interval '30 seconds'` }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
    return { ...input, claimAttempt, retryGeneration: job.retryGeneration };
  });
}

export async function releaseOutboxDispatch(db: SignalDb, input: { tenantId: string; jobId: string; claimAttempt: number }): Promise<boolean> {
  const changed = await db.update(outbox).set({ dispatchState: "PENDING", leaseExpiresAt: null }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.dispatchState, "CLAIMED"), eq(outbox.attempts, input.claimAttempt))).returning({ id: outbox.id });
  return changed.length === 1;
}

export async function markOutboxDispatched(db: SignalDb, input: { tenantId: string; jobId: string; triggerRunId: string; claimAttempt: number }): Promise<boolean> {
  const changed = await db.update(outbox).set({ dispatchState: "DISPATCHED", triggerRunId: input.triggerRunId, dispatchedAt: sql`now()`, leaseExpiresAt: null }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.dispatchState, "CLAIMED"), eq(outbox.attempts, input.claimAttempt), sql`(${outbox.triggerRunId} is null or ${outbox.triggerRunId} = ${input.triggerRunId})`)).returning({ id: outbox.id });
  return changed.length === 1;
}

export async function cleanupRetention(db: SignalDb, now = new Date()): Promise<{ snapshots: number; proposals: number }> {
  const snapshotRows = await db.update(snapshots).set({ content: { retained: false }, expiresAt: now }).where(sql`${snapshots.expiresAt} < ${now}`).returning({ id: snapshots.id });
  const proposalRows = await db.update(proposals).set({ mutation: { redacted: true } }).where(sql`${proposals.createdAt} < ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)} and ${proposals.state} in ('DISMISSED','SUPERSEDED','EXPIRED')`).returning({ id: proposals.id });
  return { snapshots: snapshotRows.length, proposals: proposalRows.length };
}

export async function loadObservedEvent(db: SignalDb, input: { tenantId: string; eventId: string }): Promise<{ tenantId: string; id: string; source: "slack" | "github"; eventType: string; channelId: string | null; threadTs: string | null; messageTs: string | null; repositoryId: string | null; repositoryOwner: string | null; repositoryName: string | null; installationId: string | null; pullRequestNumber: number | null } | null> {
  const rows = await db.select({ tenantId: observedEvents.tenantId, id: observedEvents.id, source: observedEvents.source, eventType: observedEvents.eventType, channelId: observedEvents.channelId, threadTs: observedEvents.threadTs, messageTs: observedEvents.messageTs, repositoryId: observedEvents.repositoryId, repositoryOwner: observedEvents.repositoryOwner, repositoryName: observedEvents.repositoryName, installationId: observedEvents.installationId, pullRequestNumber: observedEvents.pullRequestNumber }).from(observedEvents).where(and(eq(observedEvents.tenantId, input.tenantId), eq(observedEvents.id, input.eventId))).limit(1);
  const row = rows[0];
  if (!row || (row.source !== "slack" && row.source !== "github")) return null;
  const [tenant] = await db.select({ active: tenants.active }).from(tenants).where(and(eq(tenants.id, input.tenantId), eq(tenants.active, true))).limit(1);
  if (!tenant) return null;
  const [mapping] = await db.select({ id: channelMappings.channelId }).from(channelMappings).where(and(eq(channelMappings.tenantId, input.tenantId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false),
    row.source === "slack" ? eq(channelMappings.channelId, row.channelId ?? "") : and(eq(channelMappings.repositoryId, row.repositoryId ?? ""), eq(channelMappings.installationId, row.installationId ?? ""), eq(channelMappings.repositoryOwner, row.repositoryOwner ?? ""), eq(channelMappings.repositoryName, row.repositoryName ?? "")),
  )).limit(1);
  if (!mapping || (row.source === "github" && await resolveGitHubObserverTenant(db, { repositoryId: row.repositoryId ?? "", installationId: row.installationId ?? "" }) !== input.tenantId)) return null;
  return { ...row, source: row.source };
}

export async function recordObserverClassification(db: SignalDb, input: { tenantId: string; eventId: string; state: "SIGNAL" | "NOISE" | "BLOCKED"; reason: string; evidenceRefs: unknown }): Promise<void> {
  await db.update(observedEvents).set({ classificationState: input.state, classificationReason: input.reason, evidenceRefs: input.evidenceRefs }).where(and(eq(observedEvents.tenantId, input.tenantId), eq(observedEvents.id, input.eventId)));
}

export async function loadApprovedProposalForExecution(db: SignalDb, input: { tenantId: string; operationId: string }): Promise<import("../services/execute").ApprovedProposal | null> {
  const rows = await db.select({ tenantId: proposals.tenantId, proposalId: proposals.id, operationId: proposals.operationId, version: proposals.version, payloadHash: proposals.payloadHash, expiresAt: proposals.expiresAt, state: proposals.state, mutation: proposals.mutation }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.operationId, input.operationId))).limit(1);
  const row = rows[0];
  if (!row || row.state !== "APPROVED") return null;
  let mutation: Mutation;
  try { const parsed = MutationSchema.parse(row.mutation); if (canonicalJson(parsed) !== canonicalJson(row.mutation)) return null; mutation = row.mutation as Mutation; } catch { return null; }
  return { ...row, state: "APPROVED", mutation };
}

export async function loadIdentityMappings(db: SignalDb, tenantId: string): Promise<Record<string, string>> {
  const rows = await db.select({ slackUserId: identityMappings.slackUserId, githubLogin: identityMappings.githubLogin }).from(identityMappings).where(and(eq(identityMappings.tenantId, tenantId), eq(identityMappings.enabled, true)));
  return Object.fromEntries(rows.map((row) => [row.slackUserId, row.githubLogin]));
}

export async function loadRepositoryInstallation(db: SignalDb, input: { tenantId: string; repositoryId: string }): Promise<string | null> {
  const rows = await db.selectDistinct({ installationId: channelMappings.installationId }).from(channelMappings).innerJoin(tenants, and(eq(tenants.id, channelMappings.tenantId), eq(tenants.active, true))).where(and(eq(channelMappings.tenantId, input.tenantId), eq(channelMappings.repositoryId, input.repositoryId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false))).limit(2);
  return rows.length === 1 ? rows[0].installationId : null;
}

export async function loadMappedRepository(db: SignalDb, input: { tenantId: string; owner: string; repo: string }): Promise<{ id: string; owner: string; repo: string } | null> {
  const rows = await db.select({ id: channelMappings.repositoryId, owner: channelMappings.repositoryOwner, repo: channelMappings.repositoryName })
    .from(channelMappings)
    .innerJoin(tenants, and(eq(tenants.id, channelMappings.tenantId), eq(tenants.active, true)))
    .where(and(eq(channelMappings.tenantId, input.tenantId), eq(channelMappings.repositoryOwner, input.owner), eq(channelMappings.repositoryName, input.repo), eq(channelMappings.enabled, true)))
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}


export async function loadNotificationContext(db: SignalDb, input: { tenantId: string; operationId: string }): Promise<(import("../services/notify").NotificationOperation & { channelId: string; messageTs: string; context: import("../services/notify").NotificationContext }) | null> {
  const rows = await db.select({ tenantId: operations.tenantId, operationId: operations.id, proposalId: proposals.id, channelId: threads.channelId, messageTs: proposals.notificationMessageTs, state: operations.state, mutation: proposals.mutation, externalUrl: operations.resultExternalUrl, errorCode: operations.errorCode, resolutionNote: operations.resolutionNote, actualAssignees: operations.resultAssignees, assigneeMismatch: operations.assigneeMismatch }).from(operations)
    .innerJoin(tenants, and(eq(tenants.id, operations.tenantId), eq(tenants.active, true)))
    .innerJoin(proposals, and(eq(proposals.tenantId, operations.tenantId), eq(proposals.id, operations.proposalId), eq(proposals.operationId, operations.id)))
    .innerJoin(threads, and(eq(threads.tenantId, proposals.tenantId), eq(threads.id, proposals.threadId)))
    .innerJoin(channelMappings, and(eq(channelMappings.tenantId, threads.tenantId), eq(channelMappings.channelId, threads.channelId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false)))
    .where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(proposals.notificationState, "SENT"))).limit(1);
  const row = rows[0];
  if (!row || !row.messageTs || !["SUCCEEDED", "FAILED", "UNKNOWN", "STALE"].includes(row.state) || typeof row.mutation !== "object" || row.mutation === null || typeof (row.mutation as { kind?: unknown }).kind !== "string") return null;
  const action = (row.mutation as { kind: string }).kind;
  if (action !== "CREATE_ISSUE" && action !== "ADD_PROGRESS_COMMENT") return null;
  const context = { tenantId: row.tenantId, operationId: row.operationId, proposalId: row.proposalId, channelId: row.channelId, messageTs: row.messageTs };
  const actualAssignees = Array.isArray(row.actualAssignees) && row.actualAssignees.every((login) => typeof login === "string") ? row.actualAssignees as string[] : null;
  return { channelId: row.channelId, messageTs: row.messageTs, state: row.state as "SUCCEEDED" | "FAILED" | "UNKNOWN" | "STALE", action, externalUrl: row.externalUrl, errorCode: row.errorCode, resolutionNote: row.resolutionNote, actualAssignees, assigneeMismatch: row.assigneeMismatch, context };
}

export async function acceptObserverEvent(db: SignalDb, rawInput: ObserverEventInput, verifiedSlackTeamId?: string): Promise<{ eventId: string; jobId: string; duplicate: boolean }> {
  const input = ObserverEventSchema.parse(rawInput);
  const eventId = randomUUID();
  const jobId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      if (input.source === "slack" && (!input.channelId || !verifiedSlackTeamId?.trim() || verifiedSlackTeamId !== verifiedSlackTeamId.trim())) throw new PersistenceConflict("Intake source is unavailable");
      await lockIntakeScope(tx, { ...input, ...(input.source === "slack" ? { slackTeamId: verifiedSlackTeamId } : { channelId: null }) });
      await tx.insert(observedEvents).values({ ...input, id: eventId });
      await tx.insert(outbox).values({ tenantId: input.tenantId, id: jobId, taskId: "signal.observe-event", observerEventId: eventId });
    });
    return { eventId, jobId, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.select({ eventId: observedEvents.id }).from(observedEvents).where(and(
      eq(observedEvents.tenantId, input.tenantId),
      eq(observedEvents.source, input.source),
      eq(observedEvents.providerEventId, input.providerEventId),
    )).limit(1);
    if (!existing[0]) throw error;
    const existingJob = await db.select({ jobId: outbox.id }).from(outbox).where(and(
      eq(outbox.tenantId, input.tenantId),
      eq(outbox.observerEventId, existing[0].eventId),
    )).limit(1);
    if (!existingJob[0]) throw new Error("Observer event exists without its observation outbox job");
    return { eventId: existing[0].eventId, jobId: existingJob[0].jobId, duplicate: true };
  }
}


async function bindSuccessfulThread(tx: SignalTransaction, input: { tenantId: string; operationId: string; externalId: string; externalIssueNumber?: number }): Promise<void> {
  const [proposal] = await tx.select({ threadId: proposals.threadId, mutation: proposals.mutation }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.operationId, input.operationId)));
  if (!proposal) throw new PersistenceConflict("Result proposal is unavailable");
  const mutation = MutationSchema.parse(proposal.mutation);
  const issueId = mutation.kind === "CREATE_ISSUE" ? input.externalId : mutation.issueId;
  const issueNumber = mutation.kind === "CREATE_ISSUE" ? input.externalIssueNumber : mutation.issueNumber;
  if (!issueNumber || !Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new PersistenceConflict("Result issue number is unavailable");
  const changed = await tx.update(threads).set({ linkedIssueId: issueId, linkedIssueNumber: issueNumber, activeOperationId: null }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, proposal.threadId), eq(threads.activeOperationId, input.operationId))).returning({ id: threads.id });
  if (!changed[0]) throw new PersistenceConflict("Thread result authority was lost");
}

export async function recordSuccessfulResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; externalId: string; externalUrl?: string; externalIssueNumber?: number; actualAssignees?: string[]; assigneeMismatch?: boolean }): Promise<{ jobId: string } | null> {
  const jobId = randomUUID();
  return db.transaction(async (tx) => {
    await lockOperationScope(tx, input);
    const changed = await tx.update(operations).set({ state: "SUCCEEDED", resultExternalId: input.externalId, resultExternalUrl: input.externalUrl, resultAssignees: input.actualAssignees ?? null, assigneeMismatch: input.assigneeMismatch ?? null, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) return null;
    await bindSuccessfulThread(tx, input);
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: jobId, taskId: "signal.notify-slack", operationId: input.operationId });
    return { jobId };
  });
}


export async function recordFailedResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockOperationScope(tx, input);
    const changed = await tx.update(operations).set({ state: "FAILED", errorCode: input.errorCode, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) throw new PersistenceConflict("Operation fencing authority was lost");
    await tx.update(threads).set({ activeOperationId: null }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.activeOperationId, input.operationId)));
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: randomUUID(), taskId: "signal.notify-slack", operationId: input.operationId });
  });
}

export async function recordUnknownResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }): Promise<void> {
  const reconcileJobId = randomUUID();
  await db.transaction(async (tx) => {
    await lockOperationScope(tx, input);
    const changed = await tx.update(operations).set({ state: "UNKNOWN", errorCode: input.errorCode }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) throw new PersistenceConflict("Operation fencing authority was lost");
    const [existingRecovery] = await tx.select({ id: outbox.id }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.operationId, input.operationId), eq(outbox.taskId, "signal.reconcile-operation"))).limit(1);
    if (!existingRecovery) await tx.insert(outbox).values({ tenantId: input.tenantId, id: reconcileJobId, taskId: "signal.reconcile-operation", operationId: input.operationId });
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: randomUUID(), taskId: "signal.notify-slack", operationId: input.operationId });
  });
}

export async function recordStaleResult(db: SignalDb, input: { tenantId: string; operationId: string; errorCode: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockOperationScope(tx, input);
    const changed = await tx.update(operations).set({ state: "STALE", errorCode: input.errorCode }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "READY"))).returning({ id: operations.id });
    if (!changed[0]) return;
    await tx.update(threads).set({ activeOperationId: null }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.activeOperationId, input.operationId)));
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: randomUUID(), taskId: "signal.notify-slack", operationId: input.operationId });
  });
}

export async function loadUnknownOperation(db: SignalDb, input: { tenantId: string; operationId: string; expectedAuthorLogin: string }): Promise<UnknownOperation | null> {
  const rows = await db.select({ tenantId: operations.tenantId, operationId: operations.id, state: operations.state, leaseExpiresAt: operations.leaseExpiresAt, ownerAttemptId: operations.ownerAttemptId, fencingToken: operations.fencingToken, version: proposals.version, mutation: proposals.mutation, payloadHash: proposals.payloadHash })
    .from(operations).innerJoin(tenants, and(eq(tenants.id, operations.tenantId), eq(tenants.active, true))).innerJoin(proposals, and(eq(proposals.tenantId, operations.tenantId), eq(proposals.id, operations.proposalId)))
    .where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId))).limit(1);
  const row = rows[0];
  if (!row || !["READY", "SENDING", "SUCCEEDED", "FAILED", "UNKNOWN", "STALE"].includes(row.state)) return null;
  let mutation: Mutation;
  try { const parsed = MutationSchema.parse(row.mutation); if (canonicalJson(parsed) !== canonicalJson(row.mutation)) return null; mutation = row.mutation as Mutation; } catch { return null; }
  return { ...row, state: row.state as UnknownOperation["state"], mutation, expectedAuthorLogin: input.expectedAuthorLogin };
}

export async function transitionSendingToUnknown(db: SignalDb, input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; errorCode: string }): Promise<boolean> {
  const changed = await db.update(operations).set({ state: "UNKNOWN", errorCode: input.errorCode }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.ownerAttemptId, input.ownerAttemptId), eq(operations.fencingToken, input.fencingToken), sql`${operations.leaseExpiresAt} <= now()`, eq(operations.state, "SENDING"))).returning({ id: operations.id });
  return changed.length === 1;
}

export async function recordReconciledResult(db: SignalDb, input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; externalId: string; externalUrl: string; externalIssueNumber?: number; actualAssignees?: string[]; assigneeMismatch?: boolean }): Promise<{ jobId: string } | null> {
  const jobId = randomUUID();
  return db.transaction(async (tx) => {
    await lockOperationScope(tx, input);
    const changed = await tx.update(operations).set({ state: "SUCCEEDED", resultExternalId: input.externalId, resultExternalUrl: input.externalUrl, resultAssignees: input.actualAssignees ?? null, assigneeMismatch: input.assigneeMismatch ?? null, leaseExpiresAt: null, resolutionNote: "Reconciled from the verified GitHub marker." }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "UNKNOWN"), eq(operations.ownerAttemptId, input.ownerAttemptId), eq(operations.fencingToken, input.fencingToken), sql`${operations.leaseExpiresAt} <= now()`)).returning({ id: operations.id });
    if (!changed[0]) return null;
    await bindSuccessfulThread(tx, input);
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: jobId, taskId: "signal.notify-slack", operationId: input.operationId });
    return { jobId };
  });
}

export async function loadOwningExecutionRun(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string }): Promise<{ jobId: string; runId: string; taskId: string } | null> {
  const rows = await db.select({ jobId: outbox.id, runId: outbox.triggerRunId, taskId: outbox.taskId }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.operationId, input.operationId), eq(outbox.taskId, "signal.execute-operation"))).limit(2);
  const row = rows[0];
  if (rows.length !== 1 || !row) return null;
  if (!row.runId || input.attemptId !== row.runId) return null;
  return { ...row, runId: row.runId };
}

export async function recordOutboxExecutionOwner(db: SignalDb, input: { tenantId: string; jobId: string; runId: string }): Promise<boolean> {
  const rows = await db.update(outbox).set({ triggerRunId: input.runId }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, "signal.execute-operation"), sql`(${outbox.triggerRunId} is null or ${outbox.triggerRunId} = ${input.runId})`)).returning({ id: outbox.id });
  return rows.length === 1;
}

export async function listExpiredOperationsWithoutRecovery(db: SignalDb, limit = 20): Promise<Array<{ tenantId: string; operationId: string }>> {
  return db.select({ tenantId: operations.tenantId, operationId: operations.id }).from(operations).innerJoin(tenants, and(eq(tenants.id, operations.tenantId), eq(tenants.active, true))).where(and(
    sql`${operations.state} in ('SENDING','UNKNOWN')`, sql`${operations.leaseExpiresAt} <= now()`, sql`${operations.ownerAttemptId} is not null`,
    sql`not exists (select 1 from ${outbox} where ${outbox.tenantId} = ${operations.tenantId} and ${outbox.operationId} = ${operations.id} and ${outbox.taskId} = 'signal.reconcile-operation')`,
  )).orderBy(operations.createdAt).limit(Math.min(Math.max(1, limit), 100));
}

export async function enqueueExpiredOperationRecovery(db: SignalDb, input: { tenantId: string; operationId: string }): Promise<{ jobId: string } | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: operations.id }).from(operations).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), sql`${operations.state} in ('SENDING','UNKNOWN')`, sql`${operations.leaseExpiresAt} <= now()`, sql`${operations.ownerAttemptId} is not null`, sql`exists (select 1 from ${tenants} where ${tenants.id} = ${operations.tenantId} and ${tenants.active} = true)`)).for("update");
    if (!rows[0]) return null;
    const existing = await tx.select({ jobId: outbox.id }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.operationId, input.operationId), eq(outbox.taskId, "signal.reconcile-operation"))).limit(1);
    if (existing[0]) return existing[0];
    const jobId = randomUUID();
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: jobId, taskId: "signal.reconcile-operation", operationId: input.operationId });
    // This queues read-back work only. The task must confirm owner terminality before transition.
    return { jobId };
  });
}

export async function recordUnresolvedOperation(db: SignalDb, input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; errorCode: string; resolutionNote: string }): Promise<void> {
  const changed = await db.update(operations).set({ errorCode: input.errorCode, resolutionNote: input.resolutionNote }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "UNKNOWN"), eq(operations.ownerAttemptId, input.ownerAttemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
  if (!changed[0]) throw new PersistenceConflict("Reconciliation note authority was lost");
}

export async function appendAudit(db: SignalDb, input: { tenantId: string; actorSlackId?: string; entityType: string; entityId: string; fromState?: string; toState?: string; payloadHash?: string }): Promise<void> {
  await db.insert(audit).values({ id: randomUUID(), ...input });
}

export async function listMonitoringConversations(db: SignalDb, tenantId: string): Promise<PersistedConversationRow[]> {
  const activeTenant = await db.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, tenantId), eq(tenants.active, true))).limit(1);
  if (!activeTenant[0]) return [];

  const rows = await db
    .select({
      tenantId: threads.tenantId,
      threadId: threads.id,
      channelId: threads.channelId,
      threadTs: threads.threadTs,
      repositoryOwner: channelMappings.repositoryOwner,
      repositoryName: channelMappings.repositoryName,
      threadCreatedAt: threads.createdAt,
      proposalId: proposals.id,
      proposalState: proposals.state,
      proposalVersion: proposals.version,
      proposalExpiresAt: proposals.expiresAt,
      proposalMutation: proposals.mutation,
      operationState: operations.state,
      operationCreatedAt: operations.createdAt,
    })
    .from(threads)
    .innerJoin(channelMappings, and(eq(channelMappings.tenantId, threads.tenantId), eq(channelMappings.channelId, threads.channelId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false)))
    .leftJoin(proposals, and(eq(proposals.tenantId, threads.tenantId), eq(proposals.threadId, threads.id)))
    .leftJoin(operations, and(eq(operations.tenantId, proposals.tenantId), eq(operations.proposalId, proposals.id)))
    .where(eq(threads.tenantId, tenantId))
    .orderBy(desc(threads.createdAt));

  const latestByThread = new Map<string, PersistedConversationRow>();
  for (const row of rows) {
    const existing = latestByThread.get(row.threadId);
    if (!existing || (row.proposalVersion ?? 0) > (existing.proposalVersion ?? 0)) {
      latestByThread.set(row.threadId, row);
    }
  }
  return [...latestByThread.values()];
}

export async function listObservedConversations(db: SignalDb, tenantId: string, limit = 200): Promise<PersistedObserverRow[]> {
  const rows = await db.select({
    tenantId: observedEvents.tenantId,
    eventId: observedEvents.id,
    source: observedEvents.source,
    eventType: observedEvents.eventType,
    channelId: observedEvents.channelId,
    threadTs: observedEvents.threadTs,
    messageTs: observedEvents.messageTs,
    repositoryId: observedEvents.repositoryId,
    repositoryOwner: observedEvents.repositoryOwner,
    repositoryName: observedEvents.repositoryName,
    pullRequestNumber: observedEvents.pullRequestNumber,
    classificationState: observedEvents.classificationState,
    classificationReason: observedEvents.classificationReason,
    executionState: outbox.executionState,
    createdAt: observedEvents.createdAt,
  }).from(observedEvents)
    .innerJoin(tenants, and(eq(tenants.id, observedEvents.tenantId), eq(tenants.active, true)))
    .leftJoin(outbox, and(eq(outbox.tenantId, observedEvents.tenantId), eq(outbox.observerEventId, observedEvents.id), eq(outbox.taskId, "signal.observe-event")))
    .where(and(eq(observedEvents.tenantId, tenantId), sql`exists (select 1 from ${channelMappings} where ${channelMappings.tenantId} = ${observedEvents.tenantId} and ${channelMappings.enabled} = true and ${channelMappings.shared} = false and ((${observedEvents.source} = 'slack' and ${channelMappings.channelId} = ${observedEvents.channelId}) or (${observedEvents.source} = 'github' and ${channelMappings.repositoryId} = ${observedEvents.repositoryId} and ${channelMappings.installationId} = ${observedEvents.installationId})))`))
    .orderBy(desc(observedEvents.createdAt)).limit(Math.min(Math.max(1, limit), 200));
  const latest = new Map<string, PersistedObserverRow>();
  for (const row of rows) {
    if ((row.source !== "slack" && row.source !== "github") || !["PENDING", "SIGNAL", "NOISE", "BLOCKED"].includes(row.classificationState)) continue;
    const key = row.source === "slack"
      ? `${row.source}:${row.channelId ?? "unknown"}:${row.threadTs ?? row.messageTs ?? row.eventId}`
      : `${row.source}:${row.repositoryId ?? `${row.repositoryOwner}/${row.repositoryName}`}:${row.pullRequestNumber ?? row.eventId}`;
    if (!latest.has(key)) latest.set(key, row as PersistedObserverRow);
  }
  return [...latest.values()];
}
