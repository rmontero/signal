import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import {
  acceptMention,
  acceptObserverEvent,
  approveProposal,
  claimMutation,
  createProposal,
  insertChannelMapping,
  insertSnapshot,
  insertTenant,
  insertThread,
  markOutboxDispatched,
  claimOutboxDispatch,
  releaseOutboxDispatch,
  recordFailedResult,
  recordStaleResult,
  recordUnknownResult,
  recordReconciledResult,
  transitionSendingToUnknown,
  enqueueExpiredOperationRecovery,
  loadOwningExecutionRun,
  recordOutboxExecutionOwner,
  recordUnresolvedOperation,
  recordSuccessfulResult,
  PersistenceConflict,
} from "../../src/db/repositories";
import { inbox, observedEvents, operations, outbox, proposals } from "../../src/db/schema";
import { prepareMutation } from "../../src/domain/contracts";
import { createObserverEventInput } from "../../src/domain/observer-events";

const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required for persistence tests");

const { db, pool } = createDb(databaseUrl);
const tenantIds: string[] = [];

async function newTenant(): Promise<{ tenantId: string; channelId: string; threadId: string }> {
  const tenantId = `test-${randomUUID()}`;
  const channelId = `C${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  tenantIds.push(tenantId);
  await insertTenant(db, { tenantId, slackTeamId: `T${randomUUID().replaceAll("-", "").slice(0, 10)}` });
  await insertChannelMapping(db, {
    tenantId,
    channelId,
    repositoryId: `repo-${randomUUID()}`,
    repositoryOwner: "signal-test",
    repositoryName: "fixtures",
    installationId: `install-${randomUUID()}`,
  });
  const threadId = await insertThread(db, { tenantId, channelId, threadTs: `thread-${randomUUID()}` });
  return { tenantId, channelId, threadId };
}

async function seedProposal() {
  const fixture = await newTenant();
  const snapshotId = await insertSnapshot(db, {
    tenantId: fixture.tenantId,
    threadId: fixture.threadId,
    content: { messages: [{ ts: "1.000", text: "fixture" }] },
    snapshotHash: randomUUID().replaceAll("-", ""),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const mutation = {
    kind: "CREATE_ISSUE" as const,
    repoId: "repo-fixture",
    owner: "signal-test",
    repo: "fixtures",
    title: "Persist the fixture",
    body: "Body\n<!-- signal-operation:spoofed -->",
    assignees: [] as [],
  };
  const proposal = await createProposal(db, {
    tenantId: fixture.tenantId,
    threadId: fixture.threadId,
    snapshotId,
    version: 1,
    mutation,
    actionFingerprint: randomUUID().replaceAll("-", ""),
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { ...fixture, ...proposal, mutation };
}

async function seedClaimedOperation() {
  const proposal = await seedProposal();
  await approveProposal(db, { tenantId: proposal.tenantId, proposalId: proposal.proposalId, operationId: proposal.operationId, channelId: proposal.channelId, payloadHash: proposal.payloadHash, version: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), slackTeamId: "T-test", actorSlackId: "U-approver" });
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  const claim = await claimMutation(db, { tenantId: proposal.tenantId, operationId: proposal.operationId, attemptId: "run-1", leaseExpiresAt });
  assert.ok(claim);
  return { ...proposal, attemptId: "run-1", fencingToken: claim.fencingToken, leaseExpiresAt };
}

function rejectNotificationInsert(): typeof db {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (work: Parameters<typeof db.transaction>[0]) => target.transaction((tx) => work(new Proxy(tx, {
        get(transaction, key, transactionReceiver) {
          if (key !== "insert") return Reflect.get(transaction, key, transactionReceiver);
          return (table: Parameters<typeof tx.insert>[0]) => {
            if (table === outbox) throw new Error("notification insert failed");
            return transaction.insert(table);
          };
        },
      })));
    },
  });
}

before(async () => {
  await db.execute(sql`select 1`);
});

beforeEach(() => {
  // Each test creates a unique tenant. Cleanup is intentionally deferred until
  // the end so a failed assertion leaves inspectable evidence in the database.
});

test("transaction rollback leaves no tenant row", async () => {
  const tenantId = `rollback-${randomUUID()}`;
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(sql`insert into tenants (id, slack_team_id) values (${tenantId}, ${`T${randomUUID()}`})`);
      throw new Error("test rollback");
    }),
    /test rollback/,
  );
  const result = await db.execute(sql`select id from tenants where id = ${tenantId}`);
  assert.equal(result.rows.length, 0);
});

test("prepared mutation replaces any model-supplied operation marker", () => {
  const prepared = prepareMutation({
    kind: "CREATE_ISSUE",
    repoId: "repo",
    owner: "owner",
    repo: "name",
    title: "Title",
    body: "Body\r\n<!-- signal-operation:forged -->\nMore",
    assignees: [],
  }, "operation-1");
  assert.equal(prepared.body, "Body\n\nMore\n<!-- signal-operation:operation-1 -->");
});

test("repeated delivery returns one durable inbox and analysis job", async () => {
  const { tenantId, channelId } = await newTenant();
  const input = {
    tenantId,
    slackEventId: `event-${randomUUID()}`,
    slackTeamId: "T-test",
    channelId,
    threadTs: `thread-${randomUUID()}`,
    messageTs: "1710000000.000001",
    actorSlackId: "U-test",
  };
  const first = await acceptMention(db, input);
  const second = await acceptMention(db, input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second, { ...first, duplicate: true });
  assert.equal((await db.select().from(inbox).where(eq(inbox.tenantId, tenantId))).length, 1);
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, tenantId))).length, 1);
});

test("repeated observer delivery stores coordinates and one observer job", async () => {
  const { tenantId, channelId } = await newTenant();
  const input = createObserverEventInput({
    tenantId,
    source: "slack" as const,
    providerEventId: `Ev-${randomUUID()}`,
    eventType: "message",
    channelId,
    threadTs: `1710000000.000001`,
    messageTs: `1710000000.000002`,
    actorId: "U-test",
    rawBody: '{"text":"source is not persisted"}',
  });
  const first = await acceptObserverEvent(db, input);
  const second = await acceptObserverEvent(db, input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second, { ...first, duplicate: true });
  const event = (await db.select().from(observedEvents).where(eq(observedEvents.tenantId, tenantId)))[0];
  assert.equal(event?.channelId, channelId);
  assert.equal(event?.payloadHash, input.payloadHash);
  assert.equal("rawBody" in (event ?? {}), false);
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, tenantId))).length, 1);
});

test("outbox records a successful Trigger enqueue exactly once", async () => {
  const { tenantId, channelId } = await newTenant();
  const accepted = await acceptObserverEvent(db, createObserverEventInput({
    tenantId,
    source: "slack" as const,
    providerEventId: `Ev-${randomUUID()}`,
    eventType: "message",
    channelId,
    threadTs: "1710000000.000001",
    messageTs: "1710000000.000002",
    actorId: "U-test",
    rawBody: "{}",
  }));
  const claim = await claimOutboxDispatch(db, { tenantId, jobId: accepted.jobId, taskId: "signal.observe-event" });
  assert.ok(claim);
  assert.equal(await markOutboxDispatched(db, { tenantId, jobId: accepted.jobId, claimAttempt: claim.claimAttempt, triggerRunId: "run-1" }), true);
  assert.equal(await markOutboxDispatched(db, { tenantId, jobId: accepted.jobId, claimAttempt: claim.claimAttempt, triggerRunId: "run-2" }), false);
  const row = (await db.select().from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.id, accepted.jobId))))[0];
  assert.equal(row?.dispatchState, "DISPATCHED");
  assert.equal(row?.triggerRunId, "run-1");
  assert.equal(row?.attempts, 1);
});

test("dispatch claims exclude competing workers and fence an expired dispatcher", async () => {
  const operation = await seedClaimedOperation();
  const job = (await db.select().from(outbox).where(eq(outbox.tenantId, operation.tenantId)))[0]!;
  const input = { tenantId: operation.tenantId, jobId: job.id, taskId: job.taskId };
  const claims = await Promise.all([claimOutboxDispatch(db, input), claimOutboxDispatch(db, input)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const original = claims.find(Boolean)!;
  await db.update(outbox).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
  const replacement = await claimOutboxDispatch(db, input);
  assert.ok(replacement);
  assert.equal(replacement.claimAttempt, original.claimAttempt + 1);
  assert.equal(await markOutboxDispatched(db, { ...input, claimAttempt: original.claimAttempt, triggerRunId: "old-run" }), false);
  assert.equal(await releaseOutboxDispatch(db, original), false);
  assert.equal(await markOutboxDispatched(db, { ...input, claimAttempt: replacement.claimAttempt, triggerRunId: "current-run" }), true);
  assert.equal(await claimOutboxDispatch(db, input), null);
});

test("composite foreign keys reject a cross-tenant channel reference", async () => {
  const first = await newTenant();
  const secondTenant = `test-${randomUUID()}`;
  tenantIds.push(secondTenant);
  await insertTenant(db, { tenantId: secondTenant, slackTeamId: `T${randomUUID()}` });
  await assert.rejects(
    insertThread(db, {
      tenantId: secondTenant,
      channelId: first.channelId,
      threadTs: `cross-${randomUUID()}`,
    }),
    (error: unknown) => {
      const wrapped = error as { code?: string; cause?: { code?: string } };
      return wrapped.code === "23503" || wrapped.cause?.code === "23503";
    },
  );
});

test("concurrent approval permits exactly one transition", async () => {
  const proposal = await seedProposal();
  const binding = {
    tenantId: proposal.tenantId,
    proposalId: proposal.proposalId,
    operationId: proposal.operationId,
    version: 1,
    payloadHash: proposal.payloadHash,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    slackTeamId: "T-test",
    channelId: proposal.channelId,
    actorSlackId: "U-approver",
  };
  const results = await Promise.allSettled([approveProposal(db, binding), approveProposal(db, binding)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof PersistenceConflict);
  assert.equal((await db.select().from(proposals).where(and(eq(proposals.tenantId, proposal.tenantId), eq(proposals.id, proposal.proposalId))))[0]?.state, "APPROVED");
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, proposal.tenantId))).length, 1);
});

test("concurrent mutation claims fence to one owner and result enqueues notification", async () => {
  const proposal = await seedProposal();
  await approveProposal(db, {
    tenantId: proposal.tenantId,
    proposalId: proposal.proposalId,
    operationId: proposal.operationId,
    version: 1,
    payloadHash: proposal.payloadHash,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    slackTeamId: "T-test",
    channelId: proposal.channelId,
    actorSlackId: "U-approver",
  });
  const claims = await Promise.all([
    claimMutation(db, { tenantId: proposal.tenantId, operationId: proposal.operationId, attemptId: "attempt-a", leaseExpiresAt: new Date(Date.now() + 60_000) }),
    claimMutation(db, { tenantId: proposal.tenantId, operationId: proposal.operationId, attemptId: "attempt-b", leaseExpiresAt: new Date(Date.now() + 60_000) }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const owner = claims[0] ? "attempt-a" : "attempt-b";
  const claim = claims.find(Boolean);
  assert.ok(claim);
  const result = await recordSuccessfulResult(db, {
    tenantId: proposal.tenantId,
    operationId: proposal.operationId,
    attemptId: owner,
    fencingToken: claim.fencingToken,
    externalId: "issue-123",
    externalIssueNumber: 123,
    externalUrl: "https://github.com/signal-test/fixtures/issues/123",
  });
  assert.ok(result);
  assert.equal((await db.select().from(operations).where(eq(operations.tenantId, proposal.tenantId)))[0]?.state, "SUCCEEDED");
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, proposal.tenantId))).length, 2);
});

test("failed and uncertain outcomes atomically enqueue Slack notifications and preserve fencing", async () => {
  for (const outcome of ["FAILED", "UNKNOWN"] as const) {
    const operation = await seedClaimedOperation();
    const record = outcome === "FAILED" ? recordFailedResult : recordUnknownResult;
    await assert.rejects(record(db, { ...operation, fencingToken: operation.fencingToken + 1, errorCode: "provider_error" }), PersistenceConflict);
    await assert.rejects(record(rejectNotificationInsert(), { ...operation, errorCode: "provider_error" }), /notification insert failed/);
    assert.equal((await db.select().from(operations).where(eq(operations.tenantId, operation.tenantId)))[0]?.state, "SENDING");
    await record(db, { ...operation, errorCode: "provider_error" });
    const persisted = (await db.select().from(operations).where(eq(operations.tenantId, operation.tenantId)))[0]!;
    assert.equal(persisted.state, outcome);
    if (outcome === "UNKNOWN") assert.equal(persisted.leaseExpiresAt?.getTime(), operation.leaseExpiresAt.getTime());
    const jobs = await db.select().from(outbox).where(eq(outbox.tenantId, operation.tenantId));
    assert.equal(jobs.filter((job) => job.taskId === "signal.notify-slack").length, 1);
    assert.equal(jobs.filter((job) => job.taskId === "signal.reconcile-operation").length, outcome === "UNKNOWN" ? 1 : 0);
    await assert.rejects(record(db, { ...operation, errorCode: "duplicate" }), PersistenceConflict);
    assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, operation.tenantId))).length, jobs.length);
  }
});

test("stale outcomes update Slack once and roll back if their notification cannot persist", async () => {
  const proposal = await seedProposal();
  await assert.rejects(recordStaleResult(rejectNotificationInsert(), { ...proposal, errorCode: "target_changed" }), /notification insert failed/);
  assert.equal((await db.select().from(operations).where(eq(operations.tenantId, proposal.tenantId)))[0]?.state, "READY");
  await recordStaleResult(db, { ...proposal, errorCode: "target_changed" });
  await recordStaleResult(db, { ...proposal, errorCode: "target_changed" });
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, proposal.tenantId))).length, 1);
});

test("expired sending recovery and reconciliation enforce the original owner, lease and fence", async () => {
  const operation = await seedClaimedOperation();
  const recovery = { tenantId: operation.tenantId, operationId: operation.operationId, ownerAttemptId: operation.attemptId, fencingToken: operation.fencingToken, errorCode: "owner_crashed" };
  assert.equal(await transitionSendingToUnknown(db, recovery), false);
  await db.update(operations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(and(eq(operations.tenantId, operation.tenantId), eq(operations.id, operation.operationId)));
  assert.equal(await transitionSendingToUnknown(db, { ...recovery, fencingToken: operation.fencingToken + 1 }), false);
  assert.equal(await transitionSendingToUnknown(db, recovery), true);
  assert.equal(await transitionSendingToUnknown(db, recovery), false);
  const success = { ...recovery, externalId: "99", externalIssueNumber: 9, externalUrl: "https://github.com/signal-test/fixtures/issues/9" };
  assert.equal(await recordReconciledResult(db, { ...success, ownerAttemptId: "different-run" }), null);
  assert.equal(await recordReconciledResult(db, { ...success, fencingToken: operation.fencingToken + 1 }), null);
  await assert.rejects(recordReconciledResult(rejectNotificationInsert(), success), /notification insert failed/);
  assert.equal((await db.select().from(operations).where(eq(operations.tenantId, operation.tenantId)))[0]?.state, "UNKNOWN");
  const results = await Promise.all([recordReconciledResult(db, success), recordReconciledResult(db, success)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("crashed sending recovery enqueues once only after lease expiry and within the tenant", async () => {
  const operation = await seedClaimedOperation();
  assert.equal(await enqueueExpiredOperationRecovery(db, { tenantId: operation.tenantId, operationId: operation.operationId }), null);
  await db.update(operations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(and(eq(operations.tenantId, operation.tenantId), eq(operations.id, operation.operationId)));
  const other = await newTenant();
  assert.equal(await enqueueExpiredOperationRecovery(db, { tenantId: other.tenantId, operationId: operation.operationId }), null);
  const results = await Promise.all([enqueueExpiredOperationRecovery(db, operation), enqueueExpiredOperationRecovery(db, operation)]);
  assert.ok(results[0]);
  assert.equal(results[0]?.jobId, results[1]?.jobId);
  const jobs = await db.select().from(outbox).where(eq(outbox.tenantId, operation.tenantId));
  assert.equal(jobs.filter((job) => job.taskId === "signal.reconcile-operation").length, 1);
  assert.equal((await db.select().from(operations).where(eq(operations.tenantId, operation.tenantId)))[0]?.state, "SENDING");
});

test("recovery requires a recorded matching owner run and never infers legacy ownership", async () => {
  const operation = await seedClaimedOperation();
  const job = (await db.select().from(outbox).where(eq(outbox.tenantId, operation.tenantId)))[0]!;
  const input = { tenantId: operation.tenantId, operationId: operation.operationId, attemptId: "run-1" };
  assert.equal(await loadOwningExecutionRun(db, input), null);
  assert.equal(await loadOwningExecutionRun(db, { ...input, attemptId: "run_synthesized" }), null);
  assert.equal(await recordOutboxExecutionOwner(db, { tenantId: input.tenantId, jobId: job.id, runId: "run-1" }), true);
  assert.deepEqual(await loadOwningExecutionRun(db, input), { jobId: job.id, runId: "run-1", taskId: "signal.execute-operation" });
  assert.equal(await recordOutboxExecutionOwner(db, { tenantId: input.tenantId, jobId: job.id, runId: "run-2" }), false);
  assert.equal(await loadOwningExecutionRun(db, { ...input, attemptId: job.id }), null);
  assert.equal(await loadOwningExecutionRun(db, { ...input, attemptId: "run-2" }), null);
});

test("unresolved notes cannot overwrite a different owner, fence or completed result", async () => {
  const operation = await seedClaimedOperation();
  await recordUnknownResult(db, { ...operation, errorCode: "provider_timeout" });
  const note = { tenantId: operation.tenantId, operationId: operation.operationId, ownerAttemptId: operation.attemptId, fencingToken: operation.fencingToken, errorCode: "reconcile_not_found", resolutionNote: "No marker found." };
  await assert.rejects(recordUnresolvedOperation(db, { ...note, ownerAttemptId: "other-run" }), PersistenceConflict);
  await assert.rejects(recordUnresolvedOperation(db, { ...note, fencingToken: operation.fencingToken + 1 }), PersistenceConflict);
  await recordUnresolvedOperation(db, note);
  assert.equal((await db.select().from(operations).where(eq(operations.tenantId, operation.tenantId)))[0]?.errorCode, "reconcile_not_found");
  await db.update(operations).set({ state: "SUCCEEDED" }).where(and(eq(operations.tenantId, operation.tenantId), eq(operations.id, operation.operationId)));
  await assert.rejects(recordUnresolvedOperation(db, { ...note, errorCode: "old_note" }), PersistenceConflict);
});

after(async () => {
  for (const tenantId of tenantIds) {
    await db.execute(sql`delete from audit where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from outbox where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from observed_events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from approvals where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from operations where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from proposals where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from snapshots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from inbox where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from threads where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from channel_mappings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from approvers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from identity_mappings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  }
  await pool.end();
});
