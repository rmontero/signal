import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SignalDb } from "./client";
import { isUniqueViolation } from "./errors";
import { approvals, approvers, audit, channelMappings, identityMappings, inbox, observedEvents, operations, outbox, proposals, snapshots, slackReviews, tenants, threads } from "./schema";
import { AcceptMentionSchema, type AcceptMention, ApprovalBindingSchema, type ApprovalBinding, MutationSchema, ObserverEventSchema, type Mutation, payloadHash, prepareMutation, type PersistedConversationRow, type PersistedObserverRow } from "../domain/contracts";
import type { ApprovalProposal, ProposalReview } from "../services/approve";
import type { UnknownOperation } from "../services/reconcile";
import type { ObserverEventInput } from "../domain/observer-events";

export class PersistenceConflict extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceConflict"; }
}

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
  const rows = await db.select({ tenantId: tenants.id }).from(tenants).innerJoin(channelMappings, and(
    eq(channelMappings.tenantId, tenants.id),
    eq(channelMappings.channelId, input.channelId),
    eq(channelMappings.enabled, true),
    eq(channelMappings.shared, false),
  )).where(and(eq(tenants.slackTeamId, input.slackTeamId), eq(tenants.active, true))).limit(2);
  return rows.length === 1 ? rows[0].tenantId : null;
}

export async function resolveGitHubObserverTenant(db: SignalDb, input: { repositoryId: string; installationId: string }): Promise<string | null> {
  const rows = await db.select({ tenantId: tenants.id }).from(tenants).innerJoin(channelMappings, and(
    eq(channelMappings.tenantId, tenants.id),
    eq(channelMappings.repositoryId, input.repositoryId),
    eq(channelMappings.installationId, input.installationId),
    eq(channelMappings.enabled, true),
  )).where(eq(tenants.active, true)).limit(100);
  const tenantIds = new Set(rows.map((row) => row.tenantId));
  return tenantIds.size === 1 ? rows[0].tenantId : null;
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
type ProposalInput = { tenantId: string; proposalId?: string; threadId: string; snapshotId: string; operationId?: string; version: number; mutation: Mutation; actionFingerprint: string; expiresAt: Date };

async function createProposalInTransaction(tx: SignalTransaction, input: ProposalInput, snapshot?: { content: unknown; snapshotHash: string; expiresAt: Date }): Promise<{ proposalId: string; operationId: string; payloadHash: string }> {
  const proposalId = input.proposalId ?? randomUUID();
  const operationId = input.operationId ?? randomUUID();
  const mutation = prepareMutation(input.mutation, operationId);
  const hash = payloadHash({ schemaVersion: 1, tenantId: input.tenantId, operationId, version: input.version, mutation });
  const existing = await tx.select({ proposalId: proposals.id, operationId: proposals.operationId, payloadHash: proposals.payloadHash }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.actionFingerprint, input.actionFingerprint))).limit(1);
  if (existing[0]) return existing[0];
  if (snapshot) await tx.insert(snapshots).values({ tenantId: input.tenantId, id: input.snapshotId, threadId: input.threadId, content: snapshot.content, snapshotHash: snapshot.snapshotHash, expiresAt: snapshot.expiresAt });
  {
    const active = await tx.select({ id: proposals.id, state: proposals.state }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.threadId, input.threadId))).orderBy(desc(proposals.version)).limit(1);
    if (active[0]?.state === "APPROVED") throw new PersistenceConflict("Thread already has an approved proposal");
    if (active[0]?.state === "PENDING") await tx.update(proposals).set({ state: "SUPERSEDED" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, active[0].id)));
    await tx.insert(proposals).values({ tenantId: input.tenantId, id: proposalId, threadId: input.threadId, snapshotId: input.snapshotId, operationId, version: input.version, mutation, payloadHash: hash, actionFingerprint: input.actionFingerprint, expiresAt: input.expiresAt });
    await tx.insert(operations).values({ tenantId: input.tenantId, id: operationId, proposalId });
    await tx.update(threads).set({ activeOperationId: operationId }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, input.threadId)));
    return { proposalId, operationId, payloadHash: hash };
  }
}

export async function createProposal(db: SignalDb, input: ProposalInput): Promise<{ proposalId: string; operationId: string; payloadHash: string }> {
  return db.transaction((tx) => createProposalInTransaction(tx, input));
}

export async function acceptMention(db: SignalDb, rawInput: AcceptMention): Promise<{ inboxId: string; jobId: string; duplicate: boolean }> {
  const input = AcceptMentionSchema.parse(rawInput);
  const inboxId = randomUUID();
  const jobId = randomUUID();
  try {
    await db.transaction(async (tx) => {
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

export async function loadInboxContext(db: SignalDb, input: { tenantId: string; inboxId: string }): Promise<{ tenantId: string; inboxId: string; actorSlackId: string; channelId: string; threadTs: string; messageTs: string; threadId: string; repository: { repoId: string; owner: string; repo: string } } | null> {
  const rows = await db.select({ tenantId: inbox.tenantId, inboxId: inbox.id, actorSlackId: inbox.actorSlackId, channelId: inbox.channelId, threadTs: inbox.threadTs, messageTs: inbox.messageTs, threadId: threads.id, repoId: channelMappings.repositoryId, owner: channelMappings.repositoryOwner, repo: channelMappings.repositoryName })
    .from(inbox).innerJoin(threads, and(eq(threads.tenantId, inbox.tenantId), eq(threads.channelId, inbox.channelId), eq(threads.threadTs, inbox.threadTs))).innerJoin(channelMappings, and(eq(channelMappings.tenantId, inbox.tenantId), eq(channelMappings.channelId, inbox.channelId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false)))
    .where(and(eq(inbox.tenantId, input.tenantId), eq(inbox.id, input.inboxId))).limit(1);
  return rows[0] ? { ...rows[0], repository: { repoId: rows[0].repoId, owner: rows[0].owner, repo: rows[0].repo } } : null;
}

export async function loadOutboxJob(db: SignalDb, input: { tenantId: string; jobId: string; taskId: string }): Promise<{ tenantId: string; jobId: string; taskId: string; inboxId: string | null; proposalId: string | null; operationId: string | null; observerEventId: string | null } | null> {
  const rows = await db.select({ tenantId: outbox.tenantId, jobId: outbox.id, taskId: outbox.taskId, inboxId: outbox.inboxId, proposalId: outbox.proposalId, operationId: outbox.operationId, observerEventId: outbox.observerEventId }).from(outbox).innerJoin(tenants, and(eq(tenants.id, outbox.tenantId), eq(tenants.active, true))).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, input.taskId))).limit(1);
  return rows[0] ?? null;
}

export async function listPendingOutboxJobs(db: SignalDb, limit = 20): Promise<Array<{ tenantId: string; jobId: string; taskId: string }>> {
  const rows = await db.select({ tenantId: outbox.tenantId, jobId: outbox.id, taskId: outbox.taskId }).from(outbox).innerJoin(tenants, and(eq(tenants.id, outbox.tenantId), eq(tenants.active, true))).where(sql`(${outbox.dispatchState} = 'PENDING' or (${outbox.dispatchState} = 'CLAIMED' and ${outbox.leaseExpiresAt} <= now()))`).orderBy(outbox.createdAt).limit(Math.min(Math.max(1, limit), 100));
  return rows;
}

export async function claimOutboxDispatch(db: SignalDb, input: { tenantId: string; jobId: string; taskId: string }): Promise<{ tenantId: string; jobId: string; taskId: string; claimAttempt: number } | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ attempts: outbox.attempts }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, input.taskId), sql`(${outbox.dispatchState} = 'PENDING' or (${outbox.dispatchState} = 'CLAIMED' and ${outbox.leaseExpiresAt} <= now()))`, sql`exists (select 1 from ${tenants} where ${tenants.id} = ${outbox.tenantId} and ${tenants.active} = true)`)).for("update", { skipLocked: true });
    if (!job) return null;
    const claimAttempt = job.attempts + 1;
    await tx.update(outbox).set({ dispatchState: "CLAIMED", attempts: claimAttempt, leaseExpiresAt: sql`now() + interval '30 seconds'` }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
    return { ...input, claimAttempt };
  });
}

export async function releaseOutboxDispatch(db: SignalDb, input: { tenantId: string; jobId: string; claimAttempt: number }): Promise<boolean> {
  const changed = await db.update(outbox).set({ dispatchState: "PENDING", leaseExpiresAt: null }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.dispatchState, "CLAIMED"), eq(outbox.attempts, input.claimAttempt))).returning({ id: outbox.id });
  return changed.length === 1;
}

export async function markOutboxDispatched(db: SignalDb, input: { tenantId: string; jobId: string; triggerRunId: string; claimAttempt: number }): Promise<boolean> {
  const changed = await db.update(outbox).set({ dispatchState: "DISPATCHED", triggerRunId: input.triggerRunId, leaseExpiresAt: null }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.dispatchState, "CLAIMED"), eq(outbox.attempts, input.claimAttempt), sql`(${outbox.triggerRunId} is null or ${outbox.triggerRunId} = ${input.triggerRunId})`)).returning({ id: outbox.id });
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
  try { mutation = MutationSchema.parse(row.mutation); } catch { return null; }
  return { ...row, state: "APPROVED", mutation };
}

export async function loadIdentityMappings(db: SignalDb, tenantId: string): Promise<Record<string, string>> {
  const rows = await db.select({ slackUserId: identityMappings.slackUserId, githubLogin: identityMappings.githubLogin }).from(identityMappings).where(and(eq(identityMappings.tenantId, tenantId), eq(identityMappings.enabled, true)));
  return Object.fromEntries(rows.map((row) => [row.slackUserId, row.githubLogin]));
}

export async function loadRepositoryInstallation(db: SignalDb, input: { tenantId: string; repositoryId: string }): Promise<string | null> {
  const rows = await db.select({ installationId: channelMappings.installationId }).from(channelMappings).where(and(eq(channelMappings.tenantId, input.tenantId), eq(channelMappings.repositoryId, input.repositoryId), eq(channelMappings.enabled, true))).limit(1);
  return rows[0]?.installationId ?? null;
}

export async function loadMappedRepository(db: SignalDb, input: { tenantId: string; owner: string; repo: string }): Promise<{ id: string; owner: string; repo: string } | null> {
  const rows = await db.select({ id: channelMappings.repositoryId, owner: channelMappings.repositoryOwner, repo: channelMappings.repositoryName })
    .from(channelMappings)
    .innerJoin(tenants, and(eq(tenants.id, channelMappings.tenantId), eq(tenants.active, true)))
    .where(and(eq(channelMappings.tenantId, input.tenantId), eq(channelMappings.repositoryOwner, input.owner), eq(channelMappings.repositoryName, input.repo), eq(channelMappings.enabled, true)))
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

export async function persistAnalyzedProposal(db: SignalDb, input: { tenantId: string; proposalId?: string; threadId: string; operationId?: string; version: number; mutation: Mutation; actionFingerprint: string; expiresAt: Date; snapshot: { content: unknown; snapshotHash: string; expiresAt: Date } }): Promise<{ proposalId: string; operationId: string; payloadHash: string }> {
  const snapshotId = randomUUID();
  return db.transaction((tx) => createProposalInTransaction(tx, { ...input, snapshotId }, input.snapshot));
}

export async function setNotificationMessageTs(db: SignalDb, input: { tenantId: string; threadId: string; messageTs: string }): Promise<void> {
  await db.update(threads).set({ notificationMessageTs: input.messageTs }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, input.threadId)));
}

export async function loadNotificationContext(db: SignalDb, input: { tenantId: string; operationId: string }): Promise<{ channelId: string; messageTs: string; state: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "STALE"; action: "CREATE_ISSUE" | "ADD_PROGRESS_COMMENT"; externalUrl: string | null; errorCode: string | null; resolutionNote: string | null } | null> {
  const rows = await db.select({ channelId: threads.channelId, messageTs: threads.notificationMessageTs, state: operations.state, mutation: proposals.mutation, externalUrl: operations.resultExternalUrl, errorCode: operations.errorCode, resolutionNote: operations.resolutionNote }).from(operations).innerJoin(proposals, and(eq(proposals.tenantId, operations.tenantId), eq(proposals.id, operations.proposalId))).innerJoin(threads, and(eq(threads.tenantId, proposals.tenantId), eq(threads.id, proposals.threadId))).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId))).limit(1);
  const row = rows[0];
  if (!row || !row.messageTs || !["SUCCEEDED", "FAILED", "UNKNOWN", "STALE"].includes(row.state) || typeof row.mutation !== "object" || row.mutation === null || typeof (row.mutation as { kind?: unknown }).kind !== "string") return null;
  return { channelId: row.channelId, messageTs: row.messageTs, state: row.state as "SUCCEEDED" | "FAILED" | "UNKNOWN" | "STALE", action: (row.mutation as { kind: "CREATE_ISSUE" | "ADD_PROGRESS_COMMENT" }).kind, externalUrl: row.externalUrl, errorCode: row.errorCode, resolutionNote: row.resolutionNote };
}

export async function acceptObserverEvent(db: SignalDb, rawInput: ObserverEventInput): Promise<{ eventId: string; jobId: string; duplicate: boolean }> {
  const input = ObserverEventSchema.parse(rawInput);
  const eventId = randomUUID();
  const jobId = randomUUID();
  try {
    await db.transaction(async (tx) => {
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

export async function approveProposal(db: SignalDb, rawBinding: ApprovalBinding): Promise<{ approvalId: string; jobId: string }> {
  const binding = ApprovalBindingSchema.parse(rawBinding);
  const approvalId = randomUUID();
  const jobId = randomUUID();
  return db.transaction(async (tx) => {
    const changed = await tx.update(proposals).set({ state: "APPROVED" }).where(and(eq(proposals.tenantId, binding.tenantId), eq(proposals.id, binding.proposalId), eq(proposals.operationId, binding.operationId), eq(proposals.version, binding.version), eq(proposals.payloadHash, binding.payloadHash), eq(proposals.state, "PENDING"), sql`${proposals.expiresAt} > now()`)).returning({ id: proposals.id });
    if (!changed[0]) throw new PersistenceConflict("Proposal is stale, expired, or already approved");
    await tx.insert(approvals).values({ tenantId: binding.tenantId, id: approvalId, proposalId: binding.proposalId, operationId: binding.operationId, version: binding.version, payloadHash: binding.payloadHash, expiresAt: new Date(binding.expiresAt), slackTeamId: binding.slackTeamId, channelId: binding.channelId, actorSlackId: binding.actorSlackId });
    await tx.insert(outbox).values({ tenantId: binding.tenantId, id: jobId, taskId: "signal.execute-operation", operationId: binding.operationId });
    return { approvalId, jobId };
  });
}

export async function claimMutation(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; leaseExpiresAt: Date }): Promise<{ fencingToken: number } | null> {
  const claimed = await db.update(operations).set({ state: "SENDING", ownerAttemptId: input.attemptId, leaseExpiresAt: input.leaseExpiresAt, fencingToken: sql`${operations.fencingToken} + 1` }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "READY"), sql`exists (select 1 from ${approvals} where ${approvals.tenantId} = ${operations.tenantId} and ${approvals.operationId} = ${operations.id})`)).returning({ fencingToken: operations.fencingToken });
  return claimed[0] ?? null;
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

export async function recordSuccessfulResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; externalId: string; externalUrl?: string; externalIssueNumber?: number }): Promise<{ jobId: string } | null> {
  const jobId = randomUUID();
  return db.transaction(async (tx) => {
    const changed = await tx.update(operations).set({ state: "SUCCEEDED", resultExternalId: input.externalId, resultExternalUrl: input.externalUrl, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) return null;
    await bindSuccessfulThread(tx, input);
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: jobId, taskId: "signal.notify-slack", operationId: input.operationId });
    return { jobId };
  });
}

export async function loadProposalForApproval(db: SignalDb, input: { tenantId: string; proposalId: string }): Promise<ApprovalProposal | null> {
  const rows = await db.select({
    tenantId: proposals.tenantId, proposalId: proposals.id, operationId: proposals.operationId, version: proposals.version,
    payloadHash: proposals.payloadHash, expiresAt: proposals.expiresAt, state: proposals.state,
    slackTeamId: tenants.slackTeamId, channelId: threads.channelId, mutation: proposals.mutation,
  }).from(proposals).innerJoin(tenants, eq(tenants.id, proposals.tenantId)).innerJoin(threads, and(eq(threads.tenantId, proposals.tenantId), eq(threads.id, proposals.threadId)))
    .where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId))).limit(1);
  const row = rows[0];
  if (!row) return null;
  let mutation: Mutation;
  try { mutation = MutationSchema.parse(row.mutation); } catch { return null; }
  if (!["PENDING", "APPROVED", "DISMISSED", "SUPERSEDED", "EXPIRED"].includes(row.state)) return null;
  return { ...row, state: row.state as ApprovalProposal["state"], mutation };
}

export async function recordSlackReview(db: SignalDb, input: ProposalReview): Promise<void> {
  await db.insert(slackReviews).values(input);
}

export async function loadSlackReview(db: SignalDb, input: { tenantId: string; proposalId: string; modalId: string }): Promise<ProposalReview | null> {
  const rows = await db.select({ tenantId: slackReviews.tenantId, proposalId: slackReviews.proposalId, modalId: slackReviews.modalId, actorSlackId: slackReviews.actorSlackId, slackTeamId: slackReviews.slackTeamId, channelId: slackReviews.channelId, version: slackReviews.version })
    .from(slackReviews).where(and(eq(slackReviews.tenantId, input.tenantId), eq(slackReviews.proposalId, input.proposalId), eq(slackReviews.modalId, input.modalId))).limit(1);
  return rows[0] ?? null;
}

export async function isNamedApprover(db: SignalDb, input: { tenantId: string; channelId: string; slackUserId: string }): Promise<boolean> {
  const rows = await db.select({ slackUserId: approvers.slackUserId }).from(approvers).innerJoin(channelMappings, and(eq(channelMappings.tenantId, approvers.tenantId), eq(channelMappings.channelId, input.channelId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false)))
    .where(and(eq(approvers.tenantId, input.tenantId), eq(approvers.slackUserId, input.slackUserId), eq(approvers.enabled, true))).limit(1);
  return rows.length === 1;
}

export async function dismissProposal(db: SignalDb, input: { tenantId: string; proposalId: string; version: number }): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx.update(proposals).set({ state: "DISMISSED" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId), eq(proposals.version, input.version), eq(proposals.state, "PENDING"))).returning({ id: proposals.id, operationId: proposals.operationId });
    if (!changed[0]) throw new PersistenceConflict("Proposal is no longer pending");
    await tx.update(operations).set({ state: "STALE", errorCode: "proposal_dismissed", resolutionNote: "Proposal was dismissed in Slack." }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, changed[0].operationId), eq(operations.state, "READY")));
  });
}

export async function recordFailedResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx.update(operations).set({ state: "FAILED", errorCode: input.errorCode, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) throw new PersistenceConflict("Operation fencing authority was lost");
    await tx.update(threads).set({ activeOperationId: null }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.activeOperationId, input.operationId)));
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: randomUUID(), taskId: "signal.notify-slack", operationId: input.operationId });
  });
}

export async function recordUnknownResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }): Promise<void> {
  const reconcileJobId = randomUUID();
  await db.transaction(async (tx) => {
    const changed = await tx.update(operations).set({ state: "UNKNOWN", errorCode: input.errorCode }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) throw new PersistenceConflict("Operation fencing authority was lost");
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: reconcileJobId, taskId: "signal.reconcile-operation", operationId: input.operationId });
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: randomUUID(), taskId: "signal.notify-slack", operationId: input.operationId });
  });
}

export async function recordStaleResult(db: SignalDb, input: { tenantId: string; operationId: string; errorCode: string }): Promise<void> {
  await db.transaction(async (tx) => {
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
  try { mutation = MutationSchema.parse(row.mutation); } catch { return null; }
  return { ...row, state: row.state as UnknownOperation["state"], mutation, expectedAuthorLogin: input.expectedAuthorLogin };
}

export async function transitionSendingToUnknown(db: SignalDb, input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; errorCode: string }): Promise<boolean> {
  const changed = await db.update(operations).set({ state: "UNKNOWN", errorCode: input.errorCode }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.ownerAttemptId, input.ownerAttemptId), eq(operations.fencingToken, input.fencingToken), sql`${operations.leaseExpiresAt} <= now()`, eq(operations.state, "SENDING"))).returning({ id: operations.id });
  return changed.length === 1;
}

export async function recordReconciledResult(db: SignalDb, input: { tenantId: string; operationId: string; ownerAttemptId: string; fencingToken: number; externalId: string; externalUrl: string; externalIssueNumber?: number }): Promise<{ jobId: string } | null> {
  const jobId = randomUUID();
  return db.transaction(async (tx) => {
    const changed = await tx.update(operations).set({ state: "SUCCEEDED", resultExternalId: input.externalId, resultExternalUrl: input.externalUrl, leaseExpiresAt: null, resolutionNote: "Reconciled from the verified GitHub marker." }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "UNKNOWN"), eq(operations.ownerAttemptId, input.ownerAttemptId), eq(operations.fencingToken, input.fencingToken), sql`${operations.leaseExpiresAt} <= now()`)).returning({ id: operations.id });
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
      proposalMutation: proposals.mutation,
      operationState: operations.state,
      operationCreatedAt: operations.createdAt,
    })
    .from(threads)
    .innerJoin(channelMappings, and(eq(channelMappings.tenantId, threads.tenantId), eq(channelMappings.channelId, threads.channelId), eq(channelMappings.enabled, true)))
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
    createdAt: observedEvents.createdAt,
  }).from(observedEvents).where(eq(observedEvents.tenantId, tenantId)).orderBy(desc(observedEvents.createdAt)).limit(limit);
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
