import assert, { AssertionError } from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import {
  approveProposal, claimMutation, dismissProposal, isNamedApprover,
  loadProposalForApproval, loadSlackReview, recordSlackReview,
} from "../../src/db/approval-persistence";
import { createDb, type SignalDb } from "../../src/db/client";
import { PersistenceConflict } from "../../src/db/errors";
import { approvals, approvers, channelMappings, operations, outbox, proposals, schema, slackReviews, snapshots, tenants, threads } from "../../src/db/schema";
import { canonicalJson, type ApprovalBinding, type Mutation } from "../../src/domain/contracts";
import type { ProposalReview } from "../../src/services/approve";

// This file must never connect directly to application tables, even accidentally.
const scopedUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const namespace = scopedUrl ? new URL(scopedUrl).searchParams.get("options")?.match(/^-c search_path=(signal_test_[a-f0-9]{32})$/)?.[1] : undefined;
if (!namespace || !scopedUrl) throw new Error("A03 isolated fixture runner is required");
const { db, pool } = createDb(scopedUrl);

before(async () => {
  try {
    const result = await db.execute<{ namespace: string }>(sql`select current_schema() as namespace`);
    assert.equal(result.rows[0]?.namespace, namespace);
  } catch { throw new Error("A03 fixture isolation verification failed"); }
});
after(async () => { await pool.end(); });

function atomicTest(name: string, work: () => Promise<void>): void {
  test(`A03 atomic ${name}`, { timeout: 60_000 }, async () => {
    try { await work(); } catch (error) {
      // Drizzle failures include statement parameters; do not print fixture bodies.
      if (error instanceof AssertionError || error instanceof PersistenceConflict) throw error;
      throw new Error("A03 fixture check failed safely");
    }
  });
}

type Binding = ApprovalBinding & { modalId: string };
type Fixture = {
  tenantId: string; proposalId: string; operationId: string; threadId: string; snapshotId: string;
  channelId: string; slackTeamId: string; actorSlackId: string; modalId: string;
  configVersion: number; createdAt: Date; expiresAt: Date; mutation: Mutation;
  binding: Binding; review: ProposalReview;
};

function rawHash(f: Pick<Fixture, "tenantId" | "operationId">, mutation: unknown, version = 1): string {
  return createHash("sha256").update(canonicalJson({ schemaVersion: 1, tenantId: f.tenantId, operationId: f.operationId, version, mutation }), "utf8").digest("hex");
}

async function databaseTime(): Promise<Date> {
  const result = await db.execute<{ at: string }>(sql`select date_trunc('milliseconds', clock_timestamp())::text as at`);
  return new Date(result.rows[0].at);
}

async function fixture(options: { comment?: boolean; expired?: boolean; withoutReview?: boolean } = {}): Promise<Fixture> {
  const tenantId = `a03-${randomUUID()}`;
  const proposalId = randomUUID();
  const operationId = randomUUID();
  const threadId = randomUUID();
  const snapshotId = randomUUID();
  const channelId = `C-${randomUUID()}`;
  const slackTeamId = `T-${randomUUID()}`;
  const actorSlackId = `U-${randomUUID()}`;
  const modalId = `V-${randomUUID()}`;
  const configVersion = 7;
  const now = await databaseTime();
  const createdAt = new Date(now.getTime() - (options.expired ? 5 * 60_000 : 1_000));
  const expiresAt = new Date(now.getTime() + (options.expired ? -60_000 : 5 * 60_000));
  const target = { repoId: `repo-${randomUUID()}`, owner: "a03-synthetic", repo: "atomic-fixture", body: `Synthetic fixture.\n<!-- signal-operation:${operationId} -->` };
  const mutation: Mutation = options.comment
    ? { kind: "ADD_PROGRESS_COMMENT", ...target, issueId: "12345", issueNumber: 42 }
    : { kind: "CREATE_ISSUE", ...target, title: "Synthetic approval fixture", assignees: ["fixture-owner"] };
  const binding: Binding = { tenantId, proposalId, operationId, version: 1, payloadHash: rawHash({ tenantId, operationId }, mutation), expiresAt: expiresAt.toISOString(), channelId, slackTeamId, actorSlackId, modalId };
  const review: ProposalReview = { tenantId, proposalId, version: 1, channelId, slackTeamId, actorSlackId, modalId };
  await db.transaction(async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, slackTeamId, configVersion });
    await tx.insert(channelMappings).values({ tenantId, channelId, repositoryId: target.repoId, repositoryOwner: target.owner, repositoryName: target.repo, installationId: `install-${randomUUID()}` });
    await tx.insert(approvers).values({ tenantId, channelId, slackUserId: actorSlackId });
    await tx.insert(threads).values({ tenantId, id: threadId, channelId, threadTs: `ts-${randomUUID()}`, activeOperationId: operationId,
      ...(options.comment ? { linkedIssueId: "12345", linkedIssueNumber: 42 } : {}),
    });
    await tx.insert(snapshots).values({ tenantId, id: snapshotId, threadId, content: { synthetic: true }, snapshotHash: randomUUID(), expiresAt });
    await tx.insert(proposals).values({ tenantId, id: proposalId, threadId, snapshotId, operationId, version: 1, configVersion, mutation, payloadHash: binding.payloadHash, actionFingerprint: randomUUID(), createdAt, expiresAt });
    await tx.insert(operations).values({ tenantId, id: operationId, proposalId });
    if (!options.withoutReview) await tx.insert(slackReviews).values({ ...review, createdAt });
  });
  return { tenantId, proposalId, operationId, threadId, snapshotId, channelId, slackTeamId, actorSlackId, modalId, configVersion, createdAt, expiresAt, mutation, binding, review };
}

async function seededApproval(f: Fixture, operationState = "READY"): Promise<{ approvalId: string; jobId: string }> {
  const approvalId = randomUUID();
  const jobId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.update(proposals).set({ state: "APPROVED" }).where(proposalWhere(f));
    await tx.insert(approvals).values({ ...f.binding, id: approvalId, expiresAt: f.expiresAt, approvedAt: new Date(f.createdAt.getTime() + 500) });
    await tx.insert(outbox).values({ tenantId: f.tenantId, id: jobId, taskId: "signal.execute-operation", operationId: f.operationId });
    await tx.update(operations).set({ state: operationState }).where(operationWhere(f));
  });
  return { approvalId, jobId };
}

const proposalWhere = (f: Fixture) => and(eq(proposals.tenantId, f.tenantId), eq(proposals.id, f.proposalId));
const operationWhere = (f: Fixture) => and(eq(operations.tenantId, f.tenantId), eq(operations.id, f.operationId));
const threadWhere = (f: Fixture) => and(eq(threads.tenantId, f.tenantId), eq(threads.id, f.threadId));
const mappingWhere = (f: Fixture) => and(eq(channelMappings.tenantId, f.tenantId), eq(channelMappings.channelId, f.channelId));
const approvalWhere = (f: Fixture) => and(eq(approvals.tenantId, f.tenantId), eq(approvals.proposalId, f.proposalId));
const reviewWhere = (f: Fixture) => and(eq(slackReviews.tenantId, f.tenantId), eq(slackReviews.proposalId, f.proposalId), eq(slackReviews.modalId, f.modalId));
const actorWhere = (f: Fixture) => and(eq(approvers.tenantId, f.tenantId), eq(approvers.channelId, f.channelId), eq(approvers.slackUserId, f.actorSlackId));
const claimInput = (f: Fixture) => ({ tenantId: f.tenantId, operationId: f.operationId, attemptId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) });
const dismissInput = (f: Fixture) => ({ tenantId: f.tenantId, proposalId: f.proposalId, version: 1, slackTeamId: f.slackTeamId, channelId: f.channelId, actorSlackId: f.actorSlackId });

async function state(f: Fixture) {
  const [[proposal], [operation], [thread], approvalRows, jobRows] = await Promise.all([
    db.select({ state: proposals.state }).from(proposals).where(proposalWhere(f)),
    db.select({ state: operations.state, owner: operations.ownerAttemptId, lease: operations.leaseExpiresAt, fencingToken: operations.fencingToken, errorCode: operations.errorCode }).from(operations).where(operationWhere(f)),
    db.select({ active: threads.activeOperationId }).from(threads).where(threadWhere(f)),
    db.select({ id: approvals.id }).from(approvals).where(approvalWhere(f)),
    db.select({ id: outbox.id }).from(outbox).where(and(eq(outbox.tenantId, f.tenantId), eq(outbox.operationId, f.operationId), eq(outbox.taskId, "signal.execute-operation"))),
  ]);
  return { proposal: proposal.state, operation, active: thread.active, approvals: approvalRows.length, jobs: jobRows.length };
}

async function pristine(f: Fixture, approved = false): Promise<void> {
  const current = await state(f);
  assert.equal(current.proposal, approved ? "APPROVED" : "PENDING");
  assert.deepEqual(current.operation, { state: "READY", owner: null, lease: null, fencingToken: 0, errorCode: null });
  assert.equal(current.approvals, approved ? 1 : 0);
  assert.equal(current.jobs, approved ? 1 : 0);
}

for (const comment of [false, true]) atomicTest(`binds ${comment ? "comment" : "issue"} approval and job in one transaction`, async () => {
  const f = await fixture({ comment });
  const loaded = await loadProposalForApproval(db, f);
  assert.ok(loaded);
  assert.equal(rawHash(f, loaded.mutation), f.binding.payloadHash);
  assert.equal(loaded.expiresAt.getTime(), f.expiresAt.getTime());
  const result = await approveProposal(db, f.binding);
  const [recorded] = await db.select({ id: approvals.id, actor: approvals.actorSlackId, modal: approvals.modalId, expiresAt: approvals.expiresAt }).from(approvals).where(approvalWhere(f));
  assert.equal(recorded.id, result.approvalId);
  assert.equal(recorded.actor, f.actorSlackId);
  assert.equal(recorded.modal, f.modalId);
  assert.equal(recorded.expiresAt.getTime(), f.expiresAt.getTime());
  await pristine(f, true);
});

atomicTest("concurrent identical submits return one original approval and execution job", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([approveProposal(db, f.binding), approveProposal(db, f.binding)]);
  assert.deepEqual(second, first);
  await pristine(f, true);
});

atomicTest("expired exact replay returns its original job without active pointer or new authority", async () => {
  const f = await fixture({ expired: true });
  const original = await seededApproval(f, "SUCCEEDED");
  await db.update(threads).set({ activeOperationId: null, linkedIssueId: "98765", linkedIssueNumber: 17 }).where(threadWhere(f));
  const before = await state(f);
  assert.deepEqual(await approveProposal(db, f.binding), original);
  assert.deepEqual(await state(f), before);
  assert.equal(await claimMutation(db, claimInput(f)), null);
  await db.update(tenants).set({ configVersion: f.configVersion + 1 }).where(eq(tenants.id, f.tenantId));
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
  assert.deepEqual(await state(f), before);
});

atomicTest("replay rejects another named actor and another valid modal", async () => {
  const f = await fixture();
  await approveProposal(db, f.binding);
  const otherActor = `U-${randomUUID()}`;
  const otherModal = `V-${randomUUID()}`;
  await db.insert(approvers).values({ tenantId: f.tenantId, channelId: f.channelId, slackUserId: otherActor });
  await db.insert(slackReviews).values({ ...f.review, modalId: otherModal });
  await assert.rejects(approveProposal(db, { ...f.binding, actorSlackId: otherActor }), PersistenceConflict);
  await assert.rejects(approveProposal(db, { ...f.binding, modalId: otherModal }), PersistenceConflict);
  await pristine(f, true);
});

atomicTest("rejects every mismatched raw submitted binding without state changes", async () => {
  const f = await fixture();
  const changes: Array<Partial<Binding>> = [
    { tenantId: `${f.tenantId} ` }, { proposalId: randomUUID() }, { operationId: randomUUID() },
    { version: 2 }, { version: 1.5 }, { payloadHash: "0".repeat(64) },
    { expiresAt: new Date(f.expiresAt.getTime() + 1).toISOString() }, { expiresAt: f.binding.expiresAt.replace("Z", "+00:00") },
    { slackTeamId: `T-${randomUUID()}` }, { channelId: `C-${randomUUID()}` }, { actorSlackId: `U-${randomUUID()}` },
    { modalId: `V-${randomUUID()}` }, { modalId: ` ${f.modalId}` }, { modalId: "" },
  ];
  for (const change of changes) await assert.rejects(approveProposal(db, { ...f.binding, ...change }), PersistenceConflict);
  await assert.rejects(approveProposal(db, { ...f.binding, injected: true } as Binding), PersistenceConflict);
  await assert.rejects(approveProposal(db, { ...f.binding, modalId: undefined } as unknown as Binding), PersistenceConflict);
  await pristine(f);
});

const policyChanges: Array<[string, (f: Fixture) => Promise<unknown>]> = [
  ["disabled tenant", (f) => db.update(tenants).set({ active: false }).where(eq(tenants.id, f.tenantId))],
  ["different current team", (f) => db.update(tenants).set({ slackTeamId: `T-${randomUUID()}` }).where(eq(tenants.id, f.tenantId))],
  ["disabled mapping", (f) => db.update(channelMappings).set({ enabled: false }).where(mappingWhere(f))],
  ["shared channel", (f) => db.update(channelMappings).set({ shared: true }).where(mappingWhere(f))],
  ["changed repository id", (f) => db.update(channelMappings).set({ repositoryId: "different-repository" }).where(mappingWhere(f))],
  ["changed repository owner", (f) => db.update(channelMappings).set({ repositoryOwner: "different-owner" }).where(mappingWhere(f))],
  ["changed repository name", (f) => db.update(channelMappings).set({ repositoryName: "different-repository" }).where(mappingWhere(f))],
  ["unverified installation", (f) => db.update(channelMappings).set({ installationId: " " }).where(mappingWhere(f))],
  ["revoked named actor", (f) => db.update(approvers).set({ enabled: false }).where(actorWhere(f))],
  ["new config version", (f) => db.update(tenants).set({ configVersion: f.configVersion + 1 }).where(eq(tenants.id, f.tenantId))],
  ["legacy captured config zero", (f) => db.update(proposals).set({ configVersion: 0 }).where(proposalWhere(f))],
  ["legacy captured config negative", (f) => db.update(proposals).set({ configVersion: -1 }).where(proposalWhere(f))],
  ["invalid current config", (f) => db.update(tenants).set({ configVersion: 0 }).where(eq(tenants.id, f.tenantId))],
];

for (const [name, change] of policyChanges) atomicTest(`${name} blocks approval, modal recording, dismissal and claim`, async () => {
  const f = await fixture();
  await change(f);
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
  await assert.rejects(recordSlackReview(db, { ...f.review, modalId: `V-${randomUUID()}` }), PersistenceConflict);
  await assert.rejects(dismissProposal(db, dismissInput(f)), PersistenceConflict);
  await pristine(f);
  await seededApproval(f);
  assert.equal(await claimMutation(db, claimInput(f)), null);
  await pristine(f, true);
});

atomicTest("an approver granted only on another channel has no authority here", async () => {
  const f = await fixture();
  const otherChannel = `C-${randomUUID()}`;
  await db.insert(channelMappings).values({ tenantId: f.tenantId, channelId: otherChannel, repositoryId: f.mutation.repoId, repositoryOwner: f.mutation.owner, repositoryName: f.mutation.repo, installationId: "other-install" });
  await db.update(approvers).set({ channelId: otherChannel }).where(actorWhere(f));
  assert.equal(await isNamedApprover(db, { tenantId: f.tenantId, channelId: otherChannel, slackUserId: f.actorSlackId }), true);
  assert.equal(await isNamedApprover(db, { tenantId: f.tenantId, channelId: f.channelId, slackUserId: f.actorSlackId }), false);
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
  await assert.rejects(dismissProposal(db, dismissInput(f)), PersistenceConflict);
  await seededApproval(f);
  assert.equal(await claimMutation(db, claimInput(f)), null);
  await pristine(f, true);
});

const mutationChanges: Array<[string, (f: Fixture) => unknown, boolean]> = [
  ["body bytes", (f) => ({ ...f.mutation, body: `Changed.\n${f.mutation.body}` }), false],
  ["repository target", (f) => ({ ...f.mutation, repoId: "different-id" }), false],
  ["assignee", (f) => ({ ...f.mutation, assignees: ["another-owner"] }), false],
  ["wrong marker even with a recomputed hash", (f) => ({ ...f.mutation, body: "Synthetic.\n<!-- signal-operation:another-operation -->" }), true],
  ["extra marker even with a recomputed hash", (f) => ({ ...f.mutation, body: `<!-- signal-operation:injected -->\n${f.mutation.body}` }), true],
  ["CR line endings even with a recomputed hash", (f) => ({ ...f.mutation, body: f.mutation.body.replace("\n", "\r\n") }), true],
  ["trimmed title even with a recomputed hash", (f) => ({ ...f.mutation, title: " Synthetic approval fixture " }), true],
  ["trimmed assignee even with a recomputed hash", (f) => ({ ...f.mutation, assignees: [" fixture-owner "] }), true],
];

for (const [name, change, recompute] of mutationChanges) atomicTest(`rejects altered immutable ${name}`, async () => {
  const f = await fixture();
  const mutation = change(f);
  const hash = recompute ? rawHash(f, mutation) : f.binding.payloadHash;
  await db.update(proposals).set({ mutation, payloadHash: hash }).where(proposalWhere(f));
  f.binding.payloadHash = hash;
  assert.equal(await loadProposalForApproval(db, f), null);
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
  await seededApproval(f);
  assert.equal(await claimMutation(db, claimInput(f)), null);
  await pristine(f, true);
});

atomicTest("retains immutable body spacing instead of normalizing it", async () => {
  const f = await fixture();
  const mutation = { ...f.mutation, body: `  Synthetic whitespace.  \n\n<!-- signal-operation:${f.operationId} -->` };
  f.binding.payloadHash = rawHash(f, mutation);
  await db.update(proposals).set({ mutation, payloadHash: f.binding.payloadHash }).where(proposalWhere(f));
  const loaded = await loadProposalForApproval(db, f);
  assert.ok(loaded);
  assert.equal(rawHash(f, loaded.mutation), f.binding.payloadHash);
  await approveProposal(db, f.binding);
  assert.ok(await claimMutation(db, claimInput(f)));
});

atomicTest("comment issue identity and number are immutable", async () => {
  for (const change of [{ issueId: "54321" }, { issueNumber: 43 }]) {
    const f = await fixture({ comment: true });
    await seededApproval(f);
    await db.update(proposals).set({ mutation: { ...f.mutation, ...change } }).where(proposalWhere(f));
    await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
    assert.equal(await claimMutation(db, claimInput(f)), null);
    await pristine(f, true);
  }
});

atomicTest("modal records are exact, idempotent and cannot be reassigned", async () => {
  const f = await fixture({ withoutReview: true });
  await recordSlackReview(db, f.review);
  await recordSlackReview(db, f.review);
  assert.deepEqual(await loadSlackReview(db, f.review), f.review);
  const otherActor = `U-${randomUUID()}`;
  await db.insert(approvers).values({ tenantId: f.tenantId, channelId: f.channelId, slackUserId: otherActor });
  for (const change of [{ actorSlackId: otherActor }, { version: 2 }, { slackTeamId: "wrong-team" }, { channelId: "wrong-channel" }, { modalId: ` ${f.modalId}` }]) {
    await assert.rejects(recordSlackReview(db, { ...f.review, ...change }), PersistenceConflict);
  }
  assert.deepEqual(await loadSlackReview(db, f.review), f.review);
  assert.equal(await loadSlackReview(db, { ...f.review, tenantId: `other-${f.tenantId}` }), null);
  assert.equal(await loadProposalForApproval(db, { ...f, tenantId: `other-${f.tenantId}` }), null);
  await pristine(f);
});

atomicTest("missing and altered persisted modal bindings cannot authorize", async () => {
  const missing = await fixture({ withoutReview: true });
  await assert.rejects(approveProposal(db, missing.binding), PersistenceConflict);
  await pristine(missing);
  for (const change of [{ actorSlackId: "wrong-actor" }, { slackTeamId: "wrong-team" }, { channelId: "wrong-channel" }, { version: 2 }]) {
    const f = await fixture();
    await seededApproval(f);
    await db.update(slackReviews).set(change).where(reviewWhere(f));
    await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
    assert.equal(await claimMutation(db, claimInput(f)), null);
    await pristine(f, true);
  }
});

atomicTest("approval expiry and binding must exactly match the immutable proposal", async () => {
  for (const change of [{ expiresAt: new Date(0) }, { payloadHash: "0".repeat(64) }, { version: 2 }, { slackTeamId: "wrong-team" }, { channelId: "wrong-channel" }, { actorSlackId: "wrong-actor" }]) {
    const f = await fixture();
    await seededApproval(f);
    await db.update(approvals).set(change).where(approvalWhere(f));
    assert.equal(await claimMutation(db, claimInput(f)), null);
    await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
    await pristine(f, true);
  }
});

atomicTest("expired or overlong proposals never gain fresh authority", async () => {
  for (const expired of [true, false]) {
    const f = await fixture({ expired });
    if (!expired) {
      f.expiresAt = new Date(f.createdAt.getTime() + 31 * 60_000);
      f.binding.expiresAt = f.expiresAt.toISOString();
      await db.update(proposals).set({ expiresAt: f.expiresAt }).where(proposalWhere(f));
    }
    await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
    await assert.rejects(recordSlackReview(db, { ...f.review, modalId: randomUUID() }), PersistenceConflict);
    await assert.rejects(dismissProposal(db, dismissInput(f)), PersistenceConflict);
    await seededApproval(f);
    assert.equal(await claimMutation(db, claimInput(f)), null);
    await pristine(f, true);
  }
});

atomicTest("dismissal requires the named actor and clears only the unused active operation", async () => {
  const f = await fixture();
  await assert.rejects(dismissProposal(db, { ...dismissInput(f), actorSlackId: "not-named" }), PersistenceConflict);
  await assert.rejects(dismissProposal(db, { ...dismissInput(f), version: 2 }), PersistenceConflict);
  await dismissProposal(db, dismissInput(f));
  const current = await state(f);
  assert.equal(current.proposal, "DISMISSED");
  assert.equal(current.operation.state, "STALE");
  assert.equal(current.active, null);
  assert.equal(current.approvals, 0);
  assert.equal(current.jobs, 0);
  await assert.rejects(dismissProposal(db, dismissInput(f)), PersistenceConflict);
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
});

atomicTest("inactive thread pointer denies new approval, review, dismiss and claim", async () => {
  const f = await fixture();
  await db.update(threads).set({ activeOperationId: null }).where(threadWhere(f));
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
  await assert.rejects(recordSlackReview(db, f.review), PersistenceConflict);
  await assert.rejects(dismissProposal(db, dismissInput(f)), PersistenceConflict);
  await seededApproval(f);
  assert.equal(await claimMutation(db, claimInput(f)), null);
  await pristine(f, true);
});

atomicTest("concurrent claims create one fenced sender and never reclaim SENDING", async () => {
  const f = await fixture();
  assert.equal(await claimMutation(db, claimInput(f)), null);
  await approveProposal(db, f.binding);
  const inputs = [claimInput(f), claimInput(f)];
  const results = await Promise.all(inputs.map((input) => claimMutation(db, input)));
  assert.equal(results.filter(Boolean).length, 1);
  const winningIndex = results.findIndex(Boolean);
  assert.equal(results[winningIndex]?.fencingToken, 1);
  const current = await state(f);
  assert.equal(current.operation.state, "SENDING");
  assert.equal(current.operation.owner, inputs[winningIndex].attemptId);
  assert.equal(current.operation.lease?.getTime(), inputs[winningIndex].leaseExpiresAt.getTime());
  assert.equal(await claimMutation(db, claimInput(f)), null);
  assert.deepEqual(await state(f), current);
});

atomicTest("legacy UNKNOWN remains UNKNOWN without rewritten ownership or state", async () => {
  const f = await fixture();
  await seededApproval(f, "UNKNOWN");
  await db.update(proposals).set({ configVersion: 0 }).where(proposalWhere(f));
  await db.update(operations).set({ ownerAttemptId: "historical-owner", fencingToken: 4, leaseExpiresAt: new Date(0), errorCode: "github_unknown" }).where(operationWhere(f));
  const before = await state(f);
  assert.equal(await claimMutation(db, claimInput(f)), null);
  assert.deepEqual(await state(f), before);
});

atomicTest("an expired lease request never transitions READY", async () => {
  const f = await fixture();
  await approveProposal(db, f.binding);
  assert.equal(await claimMutation(db, { ...claimInput(f), leaseExpiresAt: new Date(0) }), null);
  await pristine(f, true);
});

atomicTest("rejects submillisecond persisted proposal expiry instead of truncating its binding", async () => {
  const f = await fixture();
  await db.update(proposals).set({ expiresAt: sql`${proposals.expiresAt} + interval '1 microsecond'` }).where(proposalWhere(f));
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
  assert.equal(await loadProposalForApproval(db, f), null);
  await pristine(f);
});

atomicTest("rejects submillisecond approval expiry at claim", async () => {
  const f = await fixture();
  await seededApproval(f);
  await db.update(approvals).set({ expiresAt: sql`${approvals.expiresAt} + interval '1 microsecond'` }).where(approvalWhere(f));
  assert.equal(await claimMutation(db, claimInput(f)), null);
  await pristine(f, true);
});

atomicTest("rejects submillisecond original expiry mismatch even on expired replay", async () => {
  const f = await fixture({ expired: true });
  await seededApproval(f, "SUCCEEDED");
  await db.update(approvals).set({ expiresAt: sql`${approvals.expiresAt} + interval '1 microsecond'` }).where(approvalWhere(f));
  await assert.rejects(approveProposal(db, f.binding), PersistenceConflict);
  const current = await state(f);
  assert.equal(current.operation.state, "SUCCEEDED");
  assert.equal(current.approvals, 1);
  assert.equal(current.jobs, 1);
});

function rejectExecutionInsert(): SignalDb {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (work: Parameters<SignalDb["transaction"]>[0]) => target.transaction((tx) => work(new Proxy(tx, {
        get(transaction, key, transactionReceiver) {
          if (key !== "insert") return Reflect.get(transaction, key, transactionReceiver);
          return (table: Parameters<typeof tx.insert>[0]) => {
            if (table === outbox) throw new Error("synthetic_outbox_failure");
            return transaction.insert(table);
          };
        },
      })));
    },
  });
}

atomicTest("outbox failure rolls approval and proposal transition back together", async () => {
  const f = await fixture();
  await assert.rejects(approveProposal(rejectExecutionInsert(), f.binding), { name: "PersistenceConflict", message: "Approval persistence is unavailable" });
  await pristine(f);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("Expected owned fixture lock or database deadline was not observed");
}

async function heldTenant(f: Fixture, changeConfig: boolean) {
  const held = deferred();
  const release = deferred();
  const completed = db.transaction(async (tx) => {
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, f.tenantId)).for("update");
    if (changeConfig) await tx.update(tenants).set({ configVersion: sql`${tenants.configVersion} + 1` }).where(eq(tenants.id, f.tenantId));
    held.resolve();
    await release.promise;
  });
  // Propagate setup failure without leaving a barrier waiting indefinitely.
  await Promise.race([held.promise, completed]);
  return { release: release.resolve, completed };
}

async function waiter() {
  const client = await pool.connect();
  const scopedDb = drizzle(client, { schema });
  const result = await scopedDb.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  const pid = result.rows[0].pid;
  return { db: scopedDb, release: () => client.release(), blocked: async () => {
    // Inspect only our own session's blocking PIDs; never statement text/content.
    const result = await db.execute<{ blocked: boolean }>(sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`);
    return result.rows[0].blocked;
  } };
}

for (const claim of [false, true]) atomicTest(`tenant lock serializes config revocation against ${claim ? "claim" : "approval"}`, async () => {
  const f = await fixture();
  if (claim) await approveProposal(db, f.binding);
  const contender = await waiter();
  const holder = await heldTenant(f, true);
  const attempt = claim
    ? claimMutation(contender.db, claimInput(f))
    : approveProposal(contender.db, f.binding).then(() => "unexpected", (error: unknown) => error instanceof PersistenceConflict ? null : Promise.reject(error));
  try {
    await until(contender.blocked);
    holder.release();
    await holder.completed;
    assert.equal(await attempt, null);
    await pristine(f, claim);
  } finally {
    holder.release();
    await Promise.allSettled([attempt, holder.completed]);
    contender.release();
  }
});

for (const claim of [false, true]) atomicTest(`${claim ? "claim" : "approval"} uses clock time after a tenant lock wait`, async () => {
  const f = await fixture();
  if (claim) await approveProposal(db, f.binding);
  const now = await databaseTime();
  f.expiresAt = new Date(now.getTime() + 2_000);
  f.binding.expiresAt = f.expiresAt.toISOString();
  await db.update(proposals).set({ expiresAt: f.expiresAt }).where(proposalWhere(f));
  if (claim) await db.update(approvals).set({ expiresAt: f.expiresAt }).where(approvalWhere(f));
  const contender = await waiter();
  const holder = await heldTenant(f, false);
  const attempt = claim
    ? claimMutation(contender.db, claimInput(f))
    : approveProposal(contender.db, f.binding).then(() => "unexpected", (error: unknown) => error instanceof PersistenceConflict ? null : Promise.reject(error));
  try {
    await until(contender.blocked);
    await until(async () => (await databaseTime()).getTime() >= f.expiresAt.getTime());
    holder.release();
    await holder.completed;
    assert.equal(await attempt, null);
    await pristine(f, claim);
  } finally {
    holder.release();
    await Promise.allSettled([attempt, holder.completed]);
    contender.release();
  }
});

atomicTest("claim never holds an operation lock while waiting for the thread", async () => {
  const f = await fixture();
  await approveProposal(db, f.binding);
  const contender = await waiter();
  const held = deferred();
  const release = deferred();
  const holder = db.transaction(async (tx) => {
    await tx.select({ id: threads.id }).from(threads).where(threadWhere(f)).for("update");
    held.resolve();
    await release.promise;
  });
  await Promise.race([held.promise, holder]);
  const attempt = claimMutation(contender.db, claimInput(f));
  try {
    await until(contender.blocked);
    await db.transaction(async (tx) => {
      const rows = await tx.select({ id: operations.id }).from(operations).where(operationWhere(f)).for("update", { noWait: true });
      assert.equal(rows.length, 1);
    });
    release.resolve();
    await holder;
    assert.equal((await attempt)?.fencingToken, 1);
  } finally {
    release.resolve();
    await Promise.allSettled([attempt, holder]);
    contender.release();
  }
});
