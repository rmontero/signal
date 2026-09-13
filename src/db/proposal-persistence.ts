import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SignalDb } from "./client";
import { PersistenceConflict } from "./errors";
import { channelMappings, inbox, operations, outbox, proposals, snapshots, tenants, threads } from "./schema";
import { actionFingerprint, AnalysisSchema, canonicalJson, MutationSchema, prepareMutation, ProposalStateSchema, type Analysis, type Mutation } from "../domain/contracts";
import type { PersistedProposal, ProposalPersistenceInput, SourceMessage, StoredAnalyzedProposal } from "../services/analyze";

type Transaction = Parameters<Parameters<SignalDb["transaction"]>[0]>[0];
type Reader = SignalDb | Transaction;
type ProposalRow = typeof proposals.$inferSelect;
type ThreadRow = typeof threads.$inferSelect;

export interface ProposalInput {
  tenantId: string;
  proposalId?: string;
  threadId: string;
  snapshotId: string;
  operationId?: string;
  version: number;
  mutation: Mutation;
  actionFingerprint: string;
  expiresAt: Date;
  analysis?: Analysis;
}

export type AnalyzedProposalInput = Omit<ProposalInput, "snapshotId" | "analysis"> & {
  analysis: Analysis;
  snapshot: ProposalPersistenceInput["snapshot"];
  payloadHash?: string;
  metadata?: ProposalPersistenceInput["metadata"];
  candidates?: ProposalPersistenceInput["candidates"];
  analysisDurationMs?: number;
};

export interface InboxAnalysisContext {
  tenantId: string;
  inboxId: string;
  actorSlackId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  threadId: string;
  repository: { repoId: string; owner: string; repo: string };
  nextVersion: number;
  linkedIssue?: { issueId: string; issueNumber: number };
  previousSourceMessages?: SourceMessage[];
}

export type ProposalNotificationState = "PENDING" | "SENDING" | "SENT" | "UNKNOWN";
export interface ProposalNotification extends StoredAnalyzedProposal {
  state: "PENDING" | "APPROVED" | "DISMISSED" | "SUPERSEDED" | "EXPIRED";
  expiresAt: Date;
  channelId: string;
  threadTs: string;
  notificationState: ProposalNotificationState;
  messageTs: string | null;
}

function conflict(message: string): never { throw new PersistenceConflict(message); }

// Drizzle errors can contain SQL parameters. Never propagate their causes/content.
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof PersistenceConflict) throw error;
    throw new PersistenceConflict("Proposal persistence failed");
  }
}

function requireId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) conflict("Proposal identity is invalid");
}

function exactMutation(value: unknown): Mutation {
  const parsed = MutationSchema.safeParse(value);
  if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(value)) conflict("Stored mutation is unavailable or invalid");
  return value as Mutation;
}

function exactAnalysis(value: unknown): Analysis {
  const parsed = AnalysisSchema.safeParse(value);
  if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(value)) conflict("Stored analysis is unavailable or invalid");
  const facts = [...parsed.data.decisions, ...parsed.data.tasks, ...parsed.data.blockers];
  if (facts.length === 0 || facts.some((fact) => fact.evidence.length === 0)) conflict("Actionable analysis requires evidence");
  return value as Analysis;
}

function rawPayloadHash(tenantId: string, operationId: string, version: number, mutation: Mutation): string {
  return createHash("sha256").update(canonicalJson({ schemaVersion: 1, tenantId, operationId, version, mutation }), "utf8").digest("hex");
}

function validateRawPayload(row: Pick<ProposalRow, "tenantId" | "operationId" | "version" | "mutation" | "payloadHash">): Mutation {
  requireId(row.operationId);
  if (!Number.isSafeInteger(row.version) || row.version <= 0) conflict("Stored proposal version is invalid");
  const mutation = exactMutation(row.mutation);
  const marker = `<!-- signal-operation:${row.operationId} -->`;
  const markers = mutation.body.match(/<!--\s*signal-operation:[^>]*-->/gi) ?? [];
  if (mutation.body.includes("\r") || !mutation.body.endsWith(`\n${marker}`) || markers.length !== 1 || markers[0] !== marker || rawPayloadHash(row.tenantId, row.operationId, row.version, mutation) !== row.payloadHash) conflict("Stored proposal immutable binding is invalid");
  return mutation;
}

function sourceHash(messages: SourceMessage[]): string {
  return createHash("sha256").update(canonicalJson(messages.map(({ ts, user, text, permalink, editedAt = null }) => ({ ts, user, text, permalink, editedAt }))), "utf8").digest("hex");
}

function sourceMessages(value: unknown, hash: string): SourceMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) conflict("Retained source snapshot is unavailable");
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") conflict("Source snapshot is invalid");
    const message = raw as SourceMessage;
    requireId(message.ts);
    if (seen.has(message.ts) || typeof message.text !== "string" || !message.text.trim() || (message.user !== null && (typeof message.user !== "string" || !message.user.trim())) || message.isBot || (message.editedAt != null && typeof message.editedAt !== "string")) conflict("Source snapshot is invalid");
    seen.add(message.ts);
    let url: URL;
    try { url = new URL(message.permalink); } catch { conflict("Source snapshot permalink is invalid"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") conflict("Source snapshot permalink is invalid");
  }
  if (sourceHash(value as SourceMessage[]) !== hash) conflict("Source snapshot hash is invalid");
  return value as SourceMessage[];
}

function validateEvidence(analysis: Analysis, messages: SourceMessage[]): void {
  const source = new Map(messages.map((message) => [message.ts, message.permalink]));
  for (const fact of [...analysis.decisions, ...analysis.tasks, ...analysis.blockers]) {
    if (fact.evidence.some((evidence) => source.get(evidence.messageTs) !== evidence.permalink)) conflict("Analysis evidence does not belong to the snapshot");
  }
}

async function lockScope(tx: Transaction, tenantId: string, threadId: string, requireActive = true) {
  requireId(tenantId); requireId(threadId);
  const [tenant] = await tx.select({ id: tenants.id, active: tenants.active, configVersion: tenants.configVersion, dbNow: sql<string>`now()::text` }).from(tenants).where(eq(tenants.id, tenantId)).for("update");
  if (!tenant || (requireActive && (!tenant.active || !Number.isSafeInteger(tenant.configVersion) || tenant.configVersion <= 0))) conflict("Active tenant configuration is unavailable");
  const [thread] = await tx.select().from(threads).where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId))).for("update");
  if (!thread) conflict("Tenant thread is unavailable");
  return { tenant, thread, now: new Date(tenant.dbNow) };
}

async function mappingFor(tx: Transaction, thread: ThreadRow) {
  const [mapping] = await tx.select().from(channelMappings).where(and(eq(channelMappings.tenantId, thread.tenantId), eq(channelMappings.channelId, thread.channelId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false))).for("share");
  if (!mapping || !mapping.installationId.trim()) conflict("Active channel repository mapping is unavailable");
  return mapping;
}

function verifyMapping(mutation: Mutation, mapping: typeof channelMappings.$inferSelect): void {
  if (mutation.repoId !== mapping.repositoryId || mutation.owner !== mapping.repositoryOwner || mutation.repo !== mapping.repositoryName) conflict("Mutation destination does not match the active channel mapping");
}

function computedFingerprint(thread: ThreadRow, snapshotHash: string, mutation: Mutation): string {
  const destination = mutation.kind === "CREATE_ISSUE" ? { repoId: mutation.repoId } : { repoId: mutation.repoId, issueId: mutation.issueId, issueNumber: mutation.issueNumber };
  return actionFingerprint({ tenantId: thread.tenantId, channelId: thread.channelId, threadTs: thread.threadTs, snapshotHash, kind: mutation.kind, destination });
}

async function storedProposal(reader: Reader, row: ProposalRow, thread: ThreadRow): Promise<StoredAnalyzedProposal> {
  const mutation = validateRawPayload(row);
  const analysis = exactAnalysis(row.analysis);
  const [snapshot] = await reader.select({ threadId: snapshots.threadId, snapshotHash: snapshots.snapshotHash }).from(snapshots).where(and(eq(snapshots.tenantId, row.tenantId), eq(snapshots.id, row.snapshotId))).limit(1);
  if (!snapshot || snapshot.threadId !== row.threadId || row.threadId !== thread.id || row.tenantId !== thread.tenantId || computedFingerprint(thread, snapshot.snapshotHash, mutation) !== row.actionFingerprint) conflict("Stored proposal snapshot binding is invalid");
  const [operation] = await reader.select({ id: operations.id }).from(operations).where(and(eq(operations.tenantId, row.tenantId), eq(operations.id, row.operationId), eq(operations.proposalId, row.id))).limit(1);
  if (!operation) conflict("Stored proposal operation binding is invalid");
  return { tenantId: row.tenantId, threadId: row.threadId, proposalId: row.id, operationId: row.operationId, version: row.version, payloadHash: row.payloadHash, snapshotHash: snapshot.snapshotHash, actionFingerprint: row.actionFingerprint, mutation, analysis };
}

export async function findStoredAnalyzedProposal(db: SignalDb, input: { tenantId: string; threadId: string; actionFingerprint: string }): Promise<StoredAnalyzedProposal | null> {
  return guarded(() => db.transaction(async (tx) => {
    requireId(input.tenantId); requireId(input.threadId); requireId(input.actionFingerprint);
    const [reference] = await tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.threadId, input.threadId), eq(proposals.actionFingerprint, input.actionFingerprint))).limit(1);
    if (!reference) return null;
    const scope = await lockScope(tx, input.tenantId, input.threadId);
    const [row] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.threadId, input.threadId), eq(proposals.actionFingerprint, input.actionFingerprint))).for("share");
    return row ? storedProposal(tx, row, scope.thread) : null;
  }));
}

async function insertProposal(tx: Transaction, input: ProposalInput, snapshotInput?: ProposalPersistenceInput["snapshot"], expectedHash?: string): Promise<PersistedProposal> {
  requireId(input.actionFingerprint);
  const { tenant, thread, now } = await lockScope(tx, input.tenantId, input.threadId);
  const mapping = await mappingFor(tx, thread);
  const [duplicate] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.actionFingerprint, input.actionFingerprint))).for("update");
  if (duplicate) {
    if (duplicate.threadId !== thread.id) conflict("Proposal fingerprint belongs to a different thread");
    const existing = await storedProposal(tx, duplicate, thread);
    verifyMapping(existing.mutation, mapping);
    return { proposalId: existing.proposalId, operationId: existing.operationId, payloadHash: existing.payloadHash, existing };
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1 || !(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now || input.expiresAt.getTime() > now.getTime() + 30 * 60_000) conflict("New proposal version or expiry is invalid");
  const analysis = input.analysis === undefined ? undefined : exactAnalysis(input.analysis);
  if (snapshotInput && !analysis) conflict("Analyzed proposal requires retained analysis");
  const operationId = input.operationId ?? randomUUID();
  const proposalId = input.proposalId ?? randomUUID();
  requireId(operationId); requireId(proposalId);
  // Generic callers prepare once here. An analyzed payload is already immutable.
  const mutation = snapshotInput && input.operationId ? exactMutation(input.mutation) : prepareMutation(input.mutation, operationId);
  const hash = rawPayloadHash(input.tenantId, operationId, input.version, mutation);
  validateRawPayload({ tenantId: input.tenantId, operationId, version: input.version, mutation, payloadHash: hash });
  if (expectedHash !== undefined && expectedHash !== hash) conflict("Analyzed proposal payload hash is invalid");
  verifyMapping(mutation, mapping);
  if (thread.linkedIssueId !== null && mutation.kind === "CREATE_ISSUE") conflict("Linked threads require a progress comment");

  const prior = await tx.select({ id: proposals.id, operationId: proposals.operationId, version: proposals.version, state: proposals.state }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.threadId, input.threadId))).orderBy(desc(proposals.version)).for("update");
  const nextVersion = (prior[0]?.version ?? 0) + 1;
  if (input.version !== nextVersion) conflict("Proposal version changed during analysis");
  const priorOperations = prior.length === 0 ? [] : await tx.select({ id: operations.id, proposalId: operations.proposalId, state: operations.state }).from(operations).where(and(eq(operations.tenantId, input.tenantId), inArray(operations.proposalId, prior.map((row) => row.id)))).for("update");
  const operationById = new Map(priorOperations.map((operation) => [operation.id, operation]));
  if (thread.activeOperationId !== null && !operationById.has(thread.activeOperationId)) conflict("Thread active operation is inconsistent");
  for (const predecessor of prior) {
    const operation = operationById.get(predecessor.operationId);
    if (!operation || operation.proposalId !== predecessor.id) conflict("Proposal operation binding is unavailable");
    if (operation.state === "SENDING" || operation.state === "UNKNOWN" || (predecessor.state === "APPROVED" && operation.state === "READY")) conflict("Thread has an unresolved approved operation");
    if (predecessor.state === "PENDING" && operation.state !== "READY") conflict("Pending proposal operation is not replaceable");
  }

  let snapshotId = input.snapshotId;
  if (snapshotInput) {
    const messages = sourceMessages(snapshotInput.content, snapshotInput.snapshotHash);
    validateEvidence(analysis!, messages);
    if (!(snapshotInput.expiresAt instanceof Date) || !Number.isFinite(snapshotInput.expiresAt.getTime()) || snapshotInput.expiresAt <= now || snapshotInput.expiresAt.getTime() > now.getTime() + 24 * 60 * 60_000) conflict("Source snapshot expiry is invalid");
    const [existingSnapshot] = await tx.select().from(snapshots).where(and(eq(snapshots.tenantId, input.tenantId), eq(snapshots.snapshotHash, snapshotInput.snapshotHash))).for("share");
    if (existingSnapshot) {
      if (existingSnapshot.threadId !== input.threadId || existingSnapshot.expiresAt <= now || canonicalJson(existingSnapshot.content) !== canonicalJson(snapshotInput.content)) conflict("Snapshot hash conflicts with retained thread content");
      snapshotId = existingSnapshot.id;
    } else {
      await tx.insert(snapshots).values({ tenantId: input.tenantId, id: snapshotId, threadId: input.threadId, ...snapshotInput });
    }
    if (computedFingerprint(thread, snapshotInput.snapshotHash, mutation) !== input.actionFingerprint) conflict("Analyzed proposal fingerprint is invalid");
  } else {
    const [snapshot] = await tx.select().from(snapshots).where(and(eq(snapshots.tenantId, input.tenantId), eq(snapshots.id, snapshotId))).for("share");
    if (!snapshot || snapshot.threadId !== input.threadId || snapshot.expiresAt <= now) conflict("Snapshot does not belong to this active tenant thread");
    if (analysis) {
      validateEvidence(analysis, sourceMessages(snapshot.content, snapshot.snapshotHash));
      if (computedFingerprint(thread, snapshot.snapshotHash, mutation) !== input.actionFingerprint) conflict("Analyzed proposal fingerprint is invalid");
    }
  }

  for (const predecessor of prior.filter((row) => row.state === "PENDING")) {
    const replaced = await tx.update(proposals).set({ state: "SUPERSEDED" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, predecessor.id), eq(proposals.state, "PENDING"))).returning({ id: proposals.id });
    const stale = await tx.update(operations).set({ state: "STALE" }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, predecessor.operationId), eq(operations.proposalId, predecessor.id), eq(operations.state, "READY"))).returning({ id: operations.id });
    if (replaced.length !== 1 || stale.length !== 1) conflict("Pending proposal changed during replacement");
  }
  await tx.insert(proposals).values({ tenantId: input.tenantId, id: proposalId, threadId: input.threadId, snapshotId, operationId, version: input.version, mutation, payloadHash: hash, actionFingerprint: input.actionFingerprint, expiresAt: input.expiresAt, analysis: analysis ?? null, configVersion: tenant.configVersion });
  await tx.insert(operations).values({ tenantId: input.tenantId, id: operationId, proposalId });
  await tx.update(threads).set({ activeOperationId: operationId }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, input.threadId)));
  if (analysis) await tx.insert(outbox).values({ tenantId: input.tenantId, id: randomUUID(), taskId: "signal.notify-slack", proposalId });
  return { proposalId, operationId, payloadHash: hash };
}

export async function createProposal(db: SignalDb, input: ProposalInput): Promise<PersistedProposal> {
  return guarded(() => db.transaction((tx) => insertProposal(tx, input)));
}

export async function persistAnalyzedProposal(db: SignalDb, input: AnalyzedProposalInput): Promise<PersistedProposal> {
  return guarded(() => db.transaction((tx) => insertProposal(tx, { ...input, snapshotId: randomUUID() }, input.snapshot, input.payloadHash)));
}

export async function loadInboxContext(db: SignalDb, input: { tenantId: string; inboxId: string }): Promise<InboxAnalysisContext | null> {
  return guarded(() => db.transaction(async (tx) => {
    requireId(input.tenantId); requireId(input.inboxId);
    const [tenant] = await tx.select({ active: tenants.active, configVersion: tenants.configVersion, dbNow: sql<string>`now()::text` }).from(tenants).where(eq(tenants.id, input.tenantId)).for("update");
    if (!tenant?.active) return null;
    if (!Number.isSafeInteger(tenant.configVersion) || tenant.configVersion <= 0) conflict("Active tenant configuration is unavailable");
    const [entry] = await tx.select().from(inbox).where(and(eq(inbox.tenantId, input.tenantId), eq(inbox.id, input.inboxId))).limit(1);
    if (!entry) return null;
    const [thread] = await tx.select().from(threads).where(and(eq(threads.tenantId, input.tenantId), eq(threads.channelId, entry.channelId), eq(threads.threadTs, entry.threadTs))).for("update");
    if (!thread) return null;
    const now = new Date(tenant.dbNow);
    const mapping = await mappingFor(tx, thread);
    const [latest] = await tx.select({ version: proposals.version }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.threadId, thread.id))).orderBy(desc(proposals.version)).limit(1).for("share");
    const [successful] = await tx.select({ content: snapshots.content, snapshotHash: snapshots.snapshotHash, expiresAt: snapshots.expiresAt, snapshotThreadId: snapshots.threadId }).from(proposals)
      .innerJoin(operations, and(eq(operations.tenantId, proposals.tenantId), eq(operations.id, proposals.operationId), eq(operations.proposalId, proposals.id), eq(operations.state, "SUCCEEDED")))
      .innerJoin(snapshots, and(eq(snapshots.tenantId, proposals.tenantId), eq(snapshots.id, proposals.snapshotId)))
      .where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.threadId, thread.id), eq(proposals.state, "APPROVED"))).orderBy(desc(proposals.version)).limit(1);
    let previousSourceMessages: SourceMessage[] | undefined;
    if (successful && successful.expiresAt > now) {
      if (successful.snapshotThreadId !== thread.id) conflict("Prior successful snapshot belongs to another thread");
      previousSourceMessages = sourceMessages(successful.content, successful.snapshotHash);
    }
    if ((thread.linkedIssueId === null) !== (thread.linkedIssueNumber === null) || (thread.linkedIssueNumber !== null && (!Number.isSafeInteger(thread.linkedIssueNumber) || thread.linkedIssueNumber <= 0))) conflict("Thread linked issue identity is invalid");
    return {
      tenantId: input.tenantId, inboxId: entry.id, actorSlackId: entry.actorSlackId, channelId: entry.channelId,
      threadTs: entry.threadTs, messageTs: entry.messageTs, threadId: thread.id,
      repository: { repoId: mapping.repositoryId, owner: mapping.repositoryOwner, repo: mapping.repositoryName },
      nextVersion: (latest?.version ?? 0) + 1,
      ...(thread.linkedIssueId !== null && thread.linkedIssueNumber !== null ? { linkedIssue: { issueId: thread.linkedIssueId, issueNumber: thread.linkedIssueNumber } } : {}),
      ...(previousSourceMessages ? { previousSourceMessages } : {}),
    };
  }));
}

async function lockNotification(tx: Transaction, input: { tenantId: string; proposalId: string }, requireActive: boolean) {
  requireId(input.tenantId); requireId(input.proposalId);
  // Resolve the immutable parent key without acquiring the proposal lock first.
  const [reference] = await tx.select({ threadId: proposals.threadId }).from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId))).limit(1);
  if (!reference) return null;
  const scope = await lockScope(tx, input.tenantId, reference.threadId, requireActive);
  const [row] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId), eq(proposals.threadId, reference.threadId))).for("update");
  if (!row) return null;
  return { ...scope, row };
}

async function notificationMaterial(tx: Transaction, scope: NonNullable<Awaited<ReturnType<typeof lockNotification>>>): Promise<ProposalNotification> {
  const stored = await storedProposal(tx, scope.row, scope.thread);
  verifyMapping(stored.mutation, await mappingFor(tx, scope.thread));
  if (scope.row.configVersion <= 0 || scope.row.configVersion !== scope.tenant.configVersion) conflict("Proposal configuration changed before notification");
  const state = ProposalStateSchema.safeParse(scope.row.state);
  if (!state.success || !["PENDING", "SENDING", "SENT", "UNKNOWN"].includes(scope.row.notificationState)) conflict("Proposal notification state is invalid");
  return { ...stored, state: state.data, expiresAt: scope.row.expiresAt, channelId: scope.thread.channelId, threadTs: scope.thread.threadTs, notificationState: scope.row.notificationState as ProposalNotificationState, messageTs: scope.row.notificationMessageTs };
}

export async function loadProposalNotification(db: SignalDb, input: { tenantId: string; proposalId: string }): Promise<ProposalNotification | null> {
  return guarded(() => db.transaction(async (tx) => {
    const scope = await lockNotification(tx, input, true);
    return scope ? notificationMaterial(tx, scope) : null;
  }));
}

export async function beginProposalNotification(db: SignalDb, input: { tenantId: string; proposalId: string }): Promise<boolean> {
  return guarded(() => db.transaction(async (tx) => {
    const scope = await lockNotification(tx, input, true);
    if (!scope || scope.row.notificationState !== "PENDING" || scope.row.notificationMessageTs !== null) return false;
    await notificationMaterial(tx, scope);
    const changed = await tx.update(proposals).set({ notificationState: "SENDING" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId), eq(proposals.notificationState, "PENDING"))).returning({ id: proposals.id });
    return changed.length === 1;
  }));
}

export async function recordProposalNotificationSent(db: SignalDb, input: { tenantId: string; proposalId: string; messageTs: string }): Promise<boolean> {
  return guarded(() => db.transaction(async (tx) => {
    requireId(input.messageTs);
    if (!/^\d{1,20}\.\d{1,10}$/.test(input.messageTs)) conflict("Slack message timestamp is invalid");
    const scope = await lockNotification(tx, input, false);
    if (!scope || scope.row.notificationState !== "SENDING") return false;
    const changed = await tx.update(proposals).set({ notificationState: "SENT", notificationMessageTs: input.messageTs }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId), eq(proposals.notificationState, "SENDING"))).returning({ id: proposals.id });
    return changed.length === 1;
  }));
}

export async function markProposalNotificationUnknown(db: SignalDb, input: { tenantId: string; proposalId: string }): Promise<boolean> {
  return guarded(() => db.transaction(async (tx) => {
    const scope = await lockNotification(tx, input, false);
    if (!scope || scope.row.notificationState !== "SENDING") return false;
    const changed = await tx.update(proposals).set({ notificationState: "UNKNOWN" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId), eq(proposals.notificationState, "SENDING"))).returning({ id: proposals.id });
    return changed.length === 1;
  }));
}
