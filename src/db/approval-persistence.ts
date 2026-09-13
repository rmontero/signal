import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ApprovalBindingSchema, canonicalJson, MutationSchema, type ApprovalBinding, type Mutation } from "../domain/contracts";
import type { ApprovalProposal, ProposalReview } from "../services/approve";
import type { SignalDb } from "./client";
import { PersistenceConflict } from "./errors";
import { approvals, approvers, channelMappings, operations, outbox, proposals, slackReviews, tenants, threads } from "./schema";

type Transaction = Parameters<Parameters<SignalDb["transaction"]>[0]>[0];
type Proposal = typeof proposals.$inferSelect;
type Context = {
  tenant: typeof tenants.$inferSelect;
  thread: typeof threads.$inferSelect;
  proposal: Proposal;
  mapping: typeof channelMappings.$inferSelect;
  mutation: Mutation;
};
type ApprovalInput = ApprovalBinding & { modalId: string };
type DismissInput = Pick<ApprovalBinding, "tenantId" | "proposalId" | "version" | "slackTeamId" | "channelId" | "actorSlackId">;

function requireAuthority(condition: unknown): asserts condition {
  if (!condition) throw new PersistenceConflict("Approval context is unavailable");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function positiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

// Drizzle errors may contain SQL and parameters. Never carry them across this boundary.
async function safely<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof PersistenceConflict) throw error;
    throw new PersistenceConflict("Approval persistence is unavailable");
  }
}

function parseBinding(input: ApprovalInput): ApprovalInput {
  try {
    const { modalId, ...rawBinding } = input;
    const binding = ApprovalBindingSchema.parse(rawBinding);
    requireAuthority(validId(modalId) && positiveVersion(binding.version));
    for (const key of ["tenantId", "proposalId", "operationId", "slackTeamId", "channelId", "actorSlackId"] as const) requireAuthority(validId(binding[key]));
    requireAuthority(canonicalJson(rawBinding) === canonicalJson(binding));
    requireAuthority(new Date(binding.expiresAt).toISOString() === binding.expiresAt);
    return { ...binding, modalId };
  } catch {
    throw new PersistenceConflict("Approval binding is invalid");
  }
}

function validateReview(input: ProposalReview): void {
  for (const key of ["tenantId", "proposalId", "modalId", "actorSlackId", "slackTeamId", "channelId"] as const) requireAuthority(validId(input[key]));
  requireAuthority(positiveVersion(input.version));
}

function immutableMutation(proposal: Proposal): Mutation {
  requireAuthority(validId(proposal.tenantId) && validId(proposal.id) && validId(proposal.operationId) && positiveVersion(proposal.version));
  const parsed = MutationSchema.safeParse(proposal.mutation);
  requireAuthority(parsed.success && canonicalJson(parsed.data) === canonicalJson(proposal.mutation));
  // Validation is not permission to normalize stored bytes or repair a marker.
  const mutation = proposal.mutation as Mutation;
  const marker = `<!-- signal-operation:${proposal.operationId} -->`;
  requireAuthority(!mutation.body.includes("\r") && mutation.body.endsWith(`\n${marker}`));
  requireAuthority((mutation.body.match(/<!--\s*signal-operation:/gi) ?? []).length === 1);
  const expectedHash = createHash("sha256").update(canonicalJson({
    schemaVersion: 1, tenantId: proposal.tenantId, operationId: proposal.operationId,
    version: proposal.version, mutation,
  }), "utf8").digest("hex");
  requireAuthority(expectedHash === proposal.payloadHash);
  requireAuthority(validDate(proposal.createdAt) && validDate(proposal.expiresAt));
  const lifetime = proposal.expiresAt.getTime() - proposal.createdAt.getTime();
  requireAuthority(lifetime > 0 && lifetime <= 30 * 60_000);
  return mutation;
}

function configured(context: Context): void {
  const { tenant, thread, proposal, mapping, mutation } = context;
  requireAuthority(tenant.active && validId(tenant.slackTeamId) && positiveVersion(tenant.configVersion));
  requireAuthority(positiveVersion(proposal.configVersion) && proposal.configVersion === tenant.configVersion);
  requireAuthority(thread.tenantId === tenant.id && proposal.tenantId === tenant.id && proposal.threadId === thread.id);
  requireAuthority(mapping.tenantId === tenant.id && mapping.channelId === thread.channelId && mapping.enabled && !mapping.shared);
  for (const id of [thread.channelId, mapping.repositoryId, mapping.repositoryOwner, mapping.repositoryName, mapping.installationId]) requireAuthority(validId(id));
  requireAuthority(mapping.repositoryId === mutation.repoId && mapping.repositoryOwner === mutation.owner && mapping.repositoryName === mutation.repo);
}

/** All write paths lock tenant -> thread -> proposal; operation locks come last. */
async function lockedContext(tx: Transaction, input: { tenantId: string; proposalId?: string; operationId?: string }): Promise<Context> {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, input.tenantId)).for("update");
  requireAuthority(tenant);
  const [hint] = await tx.select({ id: proposals.id, threadId: proposals.threadId }).from(proposals).where(and(
    eq(proposals.tenantId, input.tenantId), input.proposalId !== undefined ? eq(proposals.id, input.proposalId) : eq(proposals.operationId, input.operationId!),
  )).limit(1);
  requireAuthority(hint);
  const [thread] = await tx.select().from(threads).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, hint.threadId))).for("update");
  requireAuthority(thread);
  // Drizzle's Date mode truncates PostgreSQL timestamps to milliseconds; keep
  // finer persisted values from being mistaken for the bound expiry.
  const [proposal] = await tx.select().from(proposals).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, hint.id), eq(proposals.threadId, thread.id),
    sql`${proposals.expiresAt} = date_trunc('milliseconds', ${proposals.expiresAt})`)).for("update");
  requireAuthority(proposal && (input.operationId === undefined || proposal.operationId === input.operationId));
  const [mapping] = await tx.select().from(channelMappings).where(and(eq(channelMappings.tenantId, input.tenantId), eq(channelMappings.channelId, thread.channelId))).for("share");
  requireAuthority(mapping);
  const context = { tenant, thread, proposal, mapping, mutation: immutableMutation(proposal) };
  configured(context);
  return context;
}

async function requireActor(tx: Transaction, context: Context, input: Pick<ApprovalBinding, "slackTeamId" | "channelId" | "actorSlackId">): Promise<void> {
  requireAuthority(context.tenant.slackTeamId === input.slackTeamId && context.thread.channelId === input.channelId && validId(input.actorSlackId));
  const [actor] = await tx.select({ enabled: approvers.enabled }).from(approvers).where(and(
    eq(approvers.tenantId, context.tenant.id), eq(approvers.channelId, input.channelId), eq(approvers.slackUserId, input.actorSlackId),
  )).for("share");
  requireAuthority(actor?.enabled === true);
}

async function requireUnexpired(tx: Transaction, proposal: Proposal): Promise<void> {
  // now() is fixed at transaction start, before any lock wait. Use the actual DB clock.
  const [clock] = await tx.select({ valid: sql<boolean>`${proposal.expiresAt}::timestamptz > clock_timestamp() and ${proposal.createdAt}::timestamptz <= clock_timestamp()` }).from(tenants).where(eq(tenants.id, proposal.tenantId));
  requireAuthority(clock?.valid === true);
}

function bindingMatchesProposal(context: Context, binding: ApprovalBinding): void {
  const proposal = context.proposal;
  requireAuthority(binding.tenantId === proposal.tenantId && binding.proposalId === proposal.id && binding.operationId === proposal.operationId
    && binding.version === proposal.version && binding.payloadHash === proposal.payloadHash && binding.expiresAt === proposal.expiresAt.toISOString()
    && binding.slackTeamId === context.tenant.slackTeamId && binding.channelId === context.thread.channelId);
}

function reviewMatches(left: ProposalReview, right: ProposalReview): boolean {
  return ["tenantId", "proposalId", "modalId", "actorSlackId", "slackTeamId", "channelId", "version"].every((key) => left[key as keyof ProposalReview] === right[key as keyof ProposalReview]);
}

async function requireReview(tx: Transaction, input: ApprovalInput): Promise<void> {
  const [review] = await tx.select().from(slackReviews).where(and(eq(slackReviews.tenantId, input.tenantId), eq(slackReviews.proposalId, input.proposalId), eq(slackReviews.modalId, input.modalId))).for("share");
  requireAuthority(review && reviewMatches(review, input));
}

async function existingApproval(tx: Transaction, context: Context, input: ApprovalInput): Promise<{ approvalId: string; jobId: string }> {
  const [recorded] = await tx.select().from(approvals).where(and(eq(approvals.tenantId, input.tenantId), eq(approvals.proposalId, input.proposalId),
    sql`${approvals.expiresAt} = date_trunc('milliseconds', ${approvals.expiresAt})`)).for("share");
  requireAuthority(recorded && validDate(recorded.expiresAt) && validDate(recorded.approvedAt));
  const original = parseBinding({
    tenantId: recorded.tenantId, proposalId: recorded.proposalId, operationId: recorded.operationId,
    version: recorded.version, payloadHash: recorded.payloadHash, expiresAt: recorded.expiresAt.toISOString(),
    slackTeamId: recorded.slackTeamId, channelId: recorded.channelId, actorSlackId: recorded.actorSlackId, modalId: recorded.modalId,
  });
  requireAuthority(canonicalJson(original) === canonicalJson(input));
  requireAuthority(recorded.approvedAt.getTime() >= context.proposal.createdAt.getTime() && recorded.approvedAt.getTime() < recorded.expiresAt.getTime());
  const jobs = await tx.select({ jobId: outbox.id }).from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.operationId, input.operationId), eq(outbox.taskId, "signal.execute-operation"))).limit(2);
  requireAuthority(jobs.length === 1 && validId(recorded.id) && validId(jobs[0].jobId));
  return { approvalId: recorded.id, jobId: jobs[0].jobId };
}

export async function approveProposal(db: SignalDb, rawBinding: ApprovalInput): Promise<{ approvalId: string; jobId: string }> {
  const binding = parseBinding(rawBinding);
  return safely(() => db.transaction(async (tx) => {
    const context = await lockedContext(tx, binding);
    bindingMatchesProposal(context, binding);
    await requireActor(tx, context, binding);
    await requireReview(tx, binding);
    if (context.proposal.state === "APPROVED") return existingApproval(tx, context, binding);
    requireAuthority(context.proposal.state === "PENDING" && context.thread.activeOperationId === binding.operationId);
    const [operation] = await tx.select().from(operations).where(and(eq(operations.tenantId, binding.tenantId), eq(operations.id, binding.operationId), eq(operations.proposalId, binding.proposalId))).for("update");
    requireAuthority(operation?.state === "READY" && operation.ownerAttemptId === null && operation.leaseExpiresAt === null);
    await requireUnexpired(tx, context.proposal);
    const [changed] = await tx.update(proposals).set({ state: "APPROVED" }).where(and(
      eq(proposals.tenantId, binding.tenantId), eq(proposals.id, binding.proposalId), eq(proposals.state, "PENDING"),
      eq(proposals.version, binding.version), eq(proposals.payloadHash, binding.payloadHash), sql`${proposals.expiresAt} > clock_timestamp()`,
    )).returning({ id: proposals.id });
    requireAuthority(changed);
    const approvalId = randomUUID();
    const jobId = randomUUID();
    // Timestamp the actual transition, not the transaction's potentially old start time.
    const [inserted] = await tx.insert(approvals).values({ ...binding, id: approvalId, expiresAt: context.proposal.expiresAt, approvedAt: sql`clock_timestamp()` }).returning({ approvedAt: approvals.approvedAt });
    requireAuthority(inserted.approvedAt.getTime() < context.proposal.expiresAt.getTime());
    await tx.insert(outbox).values({ tenantId: binding.tenantId, id: jobId, taskId: "signal.execute-operation", operationId: binding.operationId });
    return { approvalId, jobId };
  }));
}

export async function claimMutation(db: SignalDb, input: { tenantId: string; operationId: string; attemptId: string; leaseExpiresAt: Date }): Promise<{ fencingToken: number } | null> {
  requireAuthority(validId(input.tenantId) && validId(input.operationId) && validId(input.attemptId) && validDate(input.leaseExpiresAt));
  return safely(async () => {
    try {
      return await db.transaction(async (tx) => {
        const context = await lockedContext(tx, input);
        requireAuthority(context.proposal.state === "APPROVED" && context.thread.activeOperationId === input.operationId);
        const [approval] = await tx.select().from(approvals).where(and(eq(approvals.tenantId, input.tenantId), eq(approvals.proposalId, context.proposal.id))).for("share");
        requireAuthority(approval && validDate(approval.expiresAt));
        const binding = parseBinding({
          tenantId: approval.tenantId, proposalId: approval.proposalId, operationId: approval.operationId, version: approval.version,
          payloadHash: approval.payloadHash, expiresAt: approval.expiresAt.toISOString(), slackTeamId: approval.slackTeamId,
          channelId: approval.channelId, actorSlackId: approval.actorSlackId, modalId: approval.modalId,
        });
        bindingMatchesProposal(context, binding);
        await requireActor(tx, context, binding);
        await requireReview(tx, binding);
        await existingApproval(tx, context, binding);
        const [operation] = await tx.select().from(operations).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.proposalId, context.proposal.id))).for("update");
        requireAuthority(operation?.state === "READY" && operation.ownerAttemptId === null && operation.leaseExpiresAt === null);
        requireAuthority(Number.isSafeInteger(operation.fencingToken) && operation.fencingToken >= 0 && operation.fencingToken < 2_147_483_647);
        await requireUnexpired(tx, context.proposal);
        const [claimed] = await tx.update(operations).set({ state: "SENDING", ownerAttemptId: input.attemptId, leaseExpiresAt: input.leaseExpiresAt, fencingToken: operation.fencingToken + 1 }).where(and(
          eq(operations.tenantId, input.tenantId), eq(operations.id, input.operationId), eq(operations.proposalId, context.proposal.id),
          eq(operations.state, "READY"), eq(operations.fencingToken, operation.fencingToken),
          sql`${context.proposal.expiresAt}::timestamptz > clock_timestamp()`, sql`${input.leaseExpiresAt}::timestamptz > clock_timestamp()`,
        )).returning({ fencingToken: operations.fencingToken });
        return claimed ?? null;
      });
    } catch (error) {
      if (error instanceof PersistenceConflict) return null;
      throw error;
    }
  });
}

export async function loadProposalForApproval(db: SignalDb, input: { tenantId: string; proposalId: string }): Promise<ApprovalProposal | null> {
  if (!validId(input.tenantId) || !validId(input.proposalId)) return null;
  return safely(async () => {
    const [row] = await db.select({ tenant: tenants, thread: threads, proposal: proposals, mapping: channelMappings }).from(proposals)
      .innerJoin(tenants, eq(tenants.id, proposals.tenantId))
      .innerJoin(threads, and(eq(threads.tenantId, proposals.tenantId), eq(threads.id, proposals.threadId)))
      .innerJoin(channelMappings, and(eq(channelMappings.tenantId, threads.tenantId), eq(channelMappings.channelId, threads.channelId)))
      .where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId), sql`${proposals.expiresAt} = date_trunc('milliseconds', ${proposals.expiresAt})`)).limit(1);
    if (!row || !validId(row.tenant.slackTeamId)) return null;
    try {
      const mutation = immutableMutation(row.proposal);
      configured({ ...row, mutation });
      requireAuthority(["PENDING", "APPROVED", "DISMISSED", "SUPERSEDED", "EXPIRED"].includes(row.proposal.state));
      return {
        tenantId: row.proposal.tenantId, proposalId: row.proposal.id, operationId: row.proposal.operationId,
        version: row.proposal.version, payloadHash: row.proposal.payloadHash, expiresAt: row.proposal.expiresAt,
        state: row.proposal.state as ApprovalProposal["state"], slackTeamId: row.tenant.slackTeamId, channelId: row.thread.channelId, mutation,
      };
    } catch (error) {
      if (error instanceof PersistenceConflict) return null;
      throw error;
    }
  });
}

export async function recordSlackReview(db: SignalDb, input: ProposalReview): Promise<void> {
  validateReview(input);
  return safely(() => db.transaction(async (tx) => {
    const context = await lockedContext(tx, input);
    requireAuthority(context.proposal.state === "PENDING" && context.proposal.version === input.version && context.thread.activeOperationId === context.proposal.operationId);
    await requireActor(tx, context, input);
    await requireUnexpired(tx, context.proposal);
    const existing = await tx.select().from(slackReviews).where(and(eq(slackReviews.tenantId, input.tenantId), eq(slackReviews.modalId, input.modalId))).limit(2);
    if (existing.length) { requireAuthority(existing.length === 1 && reviewMatches(existing[0], input)); return; }
    await tx.insert(slackReviews).values({
      tenantId: input.tenantId, proposalId: input.proposalId, modalId: input.modalId, actorSlackId: input.actorSlackId,
      slackTeamId: input.slackTeamId, channelId: input.channelId, version: input.version,
    });
  }));
}

export async function loadSlackReview(db: SignalDb, input: { tenantId: string; proposalId: string; modalId: string }): Promise<ProposalReview | null> {
  if (!validId(input.tenantId) || !validId(input.proposalId) || !validId(input.modalId)) return null;
  return safely(async () => {
    const [row] = await db.select({ tenantId: slackReviews.tenantId, proposalId: slackReviews.proposalId, modalId: slackReviews.modalId,
      actorSlackId: slackReviews.actorSlackId, slackTeamId: slackReviews.slackTeamId, channelId: slackReviews.channelId, version: slackReviews.version,
    }).from(slackReviews).innerJoin(tenants, and(eq(tenants.id, slackReviews.tenantId), eq(tenants.active, true), eq(tenants.slackTeamId, slackReviews.slackTeamId)))
      .where(and(eq(slackReviews.tenantId, input.tenantId), eq(slackReviews.proposalId, input.proposalId), eq(slackReviews.modalId, input.modalId))).limit(1);
    if (!row) return null;
    try { validateReview(row); return row; } catch { return null; }
  });
}

export async function isNamedApprover(db: SignalDb, input: { tenantId: string; channelId: string; slackUserId: string }): Promise<boolean> {
  if (!validId(input.tenantId) || !validId(input.channelId) || !validId(input.slackUserId)) return false;
  return safely(async () => {
    const rows = await db.select({ slackUserId: approvers.slackUserId }).from(approvers)
      .innerJoin(tenants, and(eq(tenants.id, approvers.tenantId), eq(tenants.active, true), sql`${tenants.configVersion} > 0`))
      .innerJoin(channelMappings, and(eq(channelMappings.tenantId, approvers.tenantId), eq(channelMappings.channelId, approvers.channelId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false)))
      .where(and(eq(approvers.tenantId, input.tenantId), eq(approvers.channelId, input.channelId), eq(approvers.slackUserId, input.slackUserId), eq(approvers.enabled, true))).limit(1);
    return rows.length === 1;
  });
}

export async function dismissProposal(db: SignalDb, input: DismissInput): Promise<void> {
  for (const key of ["tenantId", "proposalId", "slackTeamId", "channelId", "actorSlackId"] as const) requireAuthority(validId(input[key]));
  requireAuthority(positiveVersion(input.version));
  return safely(() => db.transaction(async (tx) => {
    const context = await lockedContext(tx, input);
    requireAuthority(context.proposal.state === "PENDING" && context.proposal.version === input.version && context.thread.activeOperationId === context.proposal.operationId);
    await requireActor(tx, context, input);
    const [operation] = await tx.select().from(operations).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, context.proposal.operationId), eq(operations.proposalId, input.proposalId))).for("update");
    requireAuthority(operation?.state === "READY" && operation.ownerAttemptId === null && operation.leaseExpiresAt === null);
    await requireUnexpired(tx, context.proposal);
    const [changed] = await tx.update(proposals).set({ state: "DISMISSED" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId), eq(proposals.state, "PENDING"), eq(proposals.version, input.version), sql`${proposals.expiresAt} > clock_timestamp()`)).returning({ id: proposals.id });
    requireAuthority(changed);
    const [staled] = await tx.update(operations).set({ state: "STALE", errorCode: "proposal_dismissed", resolutionNote: "Proposal was dismissed in Slack." }).where(and(eq(operations.tenantId, input.tenantId), eq(operations.id, operation.id), eq(operations.state, "READY"), eq(operations.fencingToken, operation.fencingToken))).returning({ id: operations.id });
    requireAuthority(staled);
    const [released] = await tx.update(threads).set({ activeOperationId: null }).where(and(eq(threads.tenantId, input.tenantId), eq(threads.id, context.thread.id), eq(threads.activeOperationId, operation.id))).returning({ id: threads.id });
    requireAuthority(released);
  }));
}
