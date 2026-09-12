import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SignalDb } from "./client";
import { isUniqueViolation } from "./errors";
import { approvals, audit, channelMappings, inbox, observedEvents, operations, outbox, proposals, snapshots, tenants, threads } from "./schema";
import { AcceptMentionSchema, type AcceptMention, ApprovalBindingSchema, type ApprovalBinding, ObserverEventSchema, type Mutation, payloadHash, prepareMutation, type PersistedConversationRow } from "../domain/contracts";
import type { ObserverEventInput } from "../domain/observer-events";

export class PersistenceConflict extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceConflict"; }
}

export async function insertTenant(db: SignalDb, input: { tenantId: string; slackTeamId: string; configVersion?: number }): Promise<void> {
  await db.insert(tenants).values({ id: input.tenantId, slackTeamId: input.slackTeamId, configVersion: input.configVersion ?? 1 });
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
