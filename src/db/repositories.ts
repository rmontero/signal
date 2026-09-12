import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SignalDb } from "./client";
import { isUniqueViolation } from "./errors";
import { approvals, approvers, audit, channelMappings, identityMappings, inbox, observedEvents, operations, outbox, proposals, snapshots, slackReviews, tenants, threads } from "./schema";
import { AcceptMentionSchema, type AcceptMention, ApprovalBindingSchema, type ApprovalBinding, MutationSchema, ObserverEventSchema, type Mutation, payloadHash, prepareMutation, type PersistedConversationRow } from "../domain/contracts";
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

export async function createProposal(db: SignalDb, input: { tenantId: string; proposalId?: string; threadId: string; snapshotId: string; operationId?: string; version: number; mutation: Mutation; actionFingerprint: string; expiresAt: Date }): Promise<{ proposalId: string; operationId: string; payloadHash: string }> {
  const proposalId = input.proposalId ?? randomUUID();
  const operationId = input.operationId ?? randomUUID();
  const mutation = prepareMutation(input.mutation, operationId);
  const hash = payloadHash({ schemaVersion: 1, tenantId: input.tenantId, operationId, version: input.version, mutation });
  return db.transaction(async (tx) => {
    const active = await tx.select({ id: proposals.id, state: proposals.state }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.threadId, input.threadId))).orderBy(desc(proposals.version)).limit(1);
    if (active[0]?.state === "APPROVED") throw new PersistenceConflict("Thread already has an approved proposal");
    if (active[0]?.state === "PENDING") await tx.update(proposals).set({ state: "SUPERSEDED" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, active[0].id)));
    await tx.insert(proposals).values({ tenantId: input.tenantId, id: proposalId, threadId: input.threadId, snapshotId: input.snapshotId, operationId, version: input.version, mutation, payloadHash: hash, actionFingerprint: input.actionFingerprint, expiresAt: input.expiresAt });
    await tx.insert(operations).values({ tenantId: input.tenantId, id: operationId, proposalId });
    await tx.update(threads).set({ activeOperationId: operationId }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, input.threadId)));
    return { proposalId, operationId, payloadHash: hash };
  });
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
  const rows = await db.select({ tenantId: outbox.tenantId, jobId: outbox.id, taskId: outbox.taskId, inboxId: outbox.inboxId, proposalId: outbox.proposalId, operationId: outbox.operationId, observerEventId: outbox.observerEventId }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId), eq(outbox.taskId, input.taskId))).limit(1);
  return rows[0] ?? null;
}

export async function loadObservedEvent(db: SignalDb, input: { tenantId: string; eventId: string }): Promise<{ tenantId: string; id: string; source: "slack" | "github"; eventType: string; channelId: string | null; threadTs: string | null; messageTs: string | null; repositoryId: string | null; repositoryOwner: string | null; repositoryName: string | null; installationId: string | null; pullRequestNumber: number | null } | null> {
  const rows = await db.select({ tenantId: observedEvents.tenantId, id: observedEvents.id, source: observedEvents.source, eventType: observedEvents.eventType, channelId: observedEvents.channelId, threadTs: observedEvents.threadTs, messageTs: observedEvents.messageTs, repositoryId: observedEvents.repositoryId, repositoryOwner: observedEvents.repositoryOwner, repositoryName: observedEvents.repositoryName, installationId: observedEvents.installationId, pullRequestNumber: observedEvents.pullRequestNumber }).from(observedEvents).where(and(eq(observedEvents.tenantId, input.tenantId), eq(observedEvents.id, input.eventId))).limit(1);
  const row = rows[0];
  if (!row || (row.source !== "slack" && row.source !== "github")) return null;
  return { ...row, source: row.source };
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

export async function persistAnalyzedProposal(db: SignalDb, input: { tenantId: string; proposalId?: string; threadId: string; operationId?: string; version: number; mutation: Mutation; actionFingerprint: string; expiresAt: Date; snapshot: { content: unknown; snapshotHash: string; expiresAt: Date } }): Promise<{ proposalId: string; operationId: string; payloadHash: string }> {
  const snapshotId = randomUUID();
  await insertSnapshot(db, { tenantId: input.tenantId, snapshotId, threadId: input.threadId, content: input.snapshot.content, snapshotHash: input.snapshot.snapshotHash, expiresAt: input.snapshot.expiresAt });
  return createProposal(db, { ...input, snapshotId });
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

export async function recordSuccessfulResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; externalId: string; externalUrl?: string }): Promise<{ jobId: string } | null> {
  const jobId = randomUUID();
  return db.transaction(async (tx) => {
    const changed = await tx.update(operations).set({ state: "SUCCEEDED", resultExternalId: input.externalId, resultExternalUrl: input.externalUrl, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) return null;
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

async function updateOperationState(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; state: "FAILED" | "UNKNOWN"; errorCode: string }): Promise<void> {
  const changed = await db.update(operations).set({ state: input.state, errorCode: input.errorCode, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
  if (!changed[0]) throw new PersistenceConflict("Operation fencing authority was lost");
}

export async function recordFailedResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }): Promise<void> {
  await updateOperationState(db, { ...input, state: "FAILED" });
}

export async function recordUnknownResult(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; fencingToken: number; errorCode: string }): Promise<void> {
  const reconcileJobId = randomUUID();
  await db.transaction(async (tx) => {
    const changed = await tx.update(operations).set({ state: "UNKNOWN", errorCode: input.errorCode, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "SENDING"), eq(operations.ownerAttemptId, input.attemptId), eq(operations.fencingToken, input.fencingToken))).returning({ id: operations.id });
    if (!changed[0]) throw new PersistenceConflict("Operation fencing authority was lost");
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: reconcileJobId, taskId: "signal.reconcile-operation", operationId: input.operationId });
  });
}

export async function recordStaleResult(db: SignalDb, input: { tenantId: string; operationId: string; errorCode: string }): Promise<void> {
  await db.update(operations).set({ state: "STALE", errorCode: input.errorCode }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "READY")));
}

export async function loadUnknownOperation(db: SignalDb, input: { tenantId: string; operationId: string; expectedAuthorLogin: string }): Promise<UnknownOperation | null> {
  const rows = await db.select({ tenantId: operations.tenantId, operationId: operations.id, state: operations.state, leaseExpiresAt: operations.leaseExpiresAt, ownerAttemptId: operations.ownerAttemptId, mutation: proposals.mutation, payloadHash: proposals.payloadHash })
    .from(operations).innerJoin(proposals, and(eq(proposals.tenantId, operations.tenantId), eq(proposals.id, operations.proposalId)))
    .where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId))).limit(1);
  const row = rows[0];
  if (!row || !["READY", "SENDING", "SUCCEEDED", "FAILED", "UNKNOWN", "STALE"].includes(row.state)) return null;
  let mutation: Mutation;
  try { mutation = MutationSchema.parse(row.mutation); } catch { return null; }
  return { ...row, state: row.state as UnknownOperation["state"], mutation, expectedAuthorLogin: input.expectedAuthorLogin };
}

export async function transitionSendingToUnknown(db: SignalDb, input: { tenantId: string; operationId: string; ownerAttemptId: string; errorCode: string }): Promise<boolean> {
  const changed = await db.update(operations).set({ state: "UNKNOWN", errorCode: input.errorCode, leaseExpiresAt: null }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.ownerAttemptId, input.ownerAttemptId), eq(operations.state, "SENDING"))).returning({ id: operations.id });
  return changed.length === 1;
}

export async function recordReconciledResult(db: SignalDb, input: { tenantId: string; operationId: string; externalId: string; externalUrl: string }): Promise<{ jobId: string } | null> {
  const jobId = randomUUID();
  return db.transaction(async (tx) => {
    const changed = await tx.update(operations).set({ state: "SUCCEEDED", resultExternalId: input.externalId, resultExternalUrl: input.externalUrl, leaseExpiresAt: null, resolutionNote: "Reconciled from the verified GitHub marker." }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "UNKNOWN"))).returning({ id: operations.id });
    if (!changed[0]) return null;
    await tx.insert(outbox).values({ tenantId: input.tenantId, id: jobId, taskId: "signal.notify-slack", operationId: input.operationId });
    return { jobId };
  });
}

export async function recordUnresolvedOperation(db: SignalDb, input: { tenantId: string; operationId: string; errorCode: string; resolutionNote: string }): Promise<void> {
  await db.update(operations).set({ state: "UNKNOWN", errorCode: input.errorCode, resolutionNote: input.resolutionNote }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.state, "UNKNOWN")));
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
