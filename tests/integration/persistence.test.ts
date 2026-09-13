import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { claimOutboxExecution, finishOutboxExecution, listRecoverableOutboxExecutions, recoverOutboxExecution } from "../../src/db/outbox-execution";
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
  listPendingOutboxJobs,
  isNamedApprover,
  recordSlackReview,
  loadNotificationContext,
  resolveGitHubObserverTenant,
  resolveSlackObserverTenant,
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
import { approvers, channelMappings, inbox, observedEvents, operations, outbox, proposals, tenants } from "../../src/db/schema";
import { prepareMutation } from "../../src/domain/contracts";
import { createObserverEventInput } from "../../src/domain/observer-events";

const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required for persistence tests");

const { db, pool } = createDb(databaseUrl);
const tenantIds: string[] = [];

async function newTenant() {
  const tenantId = `test-${randomUUID()}`;
  const channelId = `C${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const slackTeamId = `T${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const repositoryId = `repo-${randomUUID()}`;
  tenantIds.push(tenantId);
  await insertTenant(db, { tenantId, slackTeamId });
  await insertChannelMapping(db, {
    tenantId,
    channelId,
    repositoryId,
    repositoryOwner: "signal-test",
    repositoryName: "fixtures",
    installationId: `install-${randomUUID()}`,
  });
  const threadId = await insertThread(db, { tenantId, channelId, threadTs: `thread-${randomUUID()}` });
  return { tenantId, channelId, threadId, slackTeamId, repositoryId };
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
    repoId: fixture.repositoryId,
    owner: "signal-test",
    repo: "fixtures",
    title: "Persist the fixture",
    body: "Body\n<!-- signal-operation:spoofed -->",
    assignees: [] as [],
  };
  const expiresAt = new Date(Date.now() + 60_000);
  const proposal = await createProposal(db, {
    tenantId: fixture.tenantId,
    threadId: fixture.threadId,
    snapshotId,
    version: 1,
    mutation,
    actionFingerprint: randomUUID().replaceAll("-", ""),
    expiresAt,
  });
  return { ...fixture, ...proposal, mutation, expiresAt };
}

async function reviewedBinding(proposal: Awaited<ReturnType<typeof seedProposal>>) {
  const binding = { tenantId: proposal.tenantId, proposalId: proposal.proposalId, operationId: proposal.operationId,
    channelId: proposal.channelId, payloadHash: proposal.payloadHash, version: 1, expiresAt: proposal.expiresAt.toISOString(),
    slackTeamId: proposal.slackTeamId, actorSlackId: "UAPPROVER", modalId: `V${randomUUID()}` };
  await db.insert(approvers).values({ tenantId: proposal.tenantId, channelId: proposal.channelId, slackUserId: binding.actorSlackId });
  await recordSlackReview(db, binding);
  return binding;
}

async function seedClaimedOperation() {
  const proposal = await seedProposal();
  await approveProposal(db, await reviewedBinding(proposal));
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

test("completed or blocked outbox execution cannot be dispatched again", async () => {
  for (const state of ["SUCCEEDED", "BLOCKED", "RUNNING", "FAILED"]) {
    const { tenantId, channelId, slackTeamId } = await newTenant();
    const { jobId } = await acceptObserverEvent(db, createObserverEventInput({
      tenantId, source: "slack", providerEventId: `Ev-${randomUUID()}`, eventType: "message",
      channelId, threadTs: "1710000000.000001", messageTs: "1710000000.000002", actorId: "U-test", rawBody: "{}",
    }), slackTeamId);
    await db.update(outbox).set({ executionState: state }).where(and(eq(outbox.tenantId, tenantId), eq(outbox.id, jobId)));
    assert.equal(await claimOutboxDispatch(db, { tenantId, jobId, taskId: "signal.observe-event" }), null, state);
    assert.equal((await listPendingOutboxJobs(db, 100)).some((job) => job.jobId === jobId), false, state);
  }
});

test("named approval authority does not leak across mapped channels", async () => {
  const { tenantId, channelId } = await newTenant();
  const otherChannel = `C${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await insertChannelMapping(db, { tenantId, channelId: otherChannel, repositoryId: "another-repo", repositoryOwner: "signal-test", repositoryName: "other", installationId: "other-install" });
  await db.insert(approvers).values({ tenantId, slackUserId: "U-approver", ...{ channelId } });
  assert.equal(await isNamedApprover(db, { tenantId, channelId, slackUserId: "U-approver" }), true);
  assert.equal(await isNamedApprover(db, { tenantId, channelId: otherChannel, slackUserId: "U-approver" }), false);
});

test("GitHub tenant resolution detects ambiguity beyond one hundred same-tenant mappings", async () => {
  const first = await newTenant();
  const second = await newTenant();
  const input = { repositoryId: `shared-${randomUUID()}`, installationId: `installation-${randomUUID()}` };
  await db.insert(channelMappings).values(Array.from({ length: 101 }, (_, index) => ({ tenantId: first.tenantId, channelId: `CBULK${index}`, ...input, repositoryOwner: "signal-test", repositoryName: "shared" })));
  await insertChannelMapping(db, { ...input, tenantId: second.tenantId, channelId: "CSECOND", repositoryOwner: "signal-test", repositoryName: "shared" });
  assert.equal(await resolveGitHubObserverTenant(db, input), null);
  await db.update(tenants).set({ active: false }).where(eq(tenants.id, second.tenantId));
  assert.equal(await resolveGitHubObserverTenant(db, input), first.tenantId);
  await db.update(channelMappings).set({ shared: true }).where(and(eq(channelMappings.tenantId, first.tenantId), eq(channelMappings.repositoryId, input.repositoryId)));
  assert.equal(await resolveGitHubObserverTenant(db, input), null);
});

test("intake rechecks tenant and mapping revocation after route resolution", async () => {
  const fixture = await newTenant();
  const { tenantId, channelId, slackTeamId } = fixture;
  assert.equal(await resolveSlackObserverTenant(db, fixture), tenantId);
  const mention = { tenantId, channelId, slackTeamId, slackEventId: `Ev${randomUUID()}`, threadTs: "1710000000.000010", messageTs: "1710000000.000011", actorSlackId: "UACTOR" };
  const observer = createObserverEventInput({ tenantId, channelId, source: "slack", providerEventId: `Ev${randomUUID()}`, eventType: "message", threadTs: mention.threadTs, messageTs: mention.messageTs, rawBody: "{}" });
  await db.update(channelMappings).set({ enabled: false }).where(and(eq(channelMappings.tenantId, tenantId), eq(channelMappings.channelId, channelId)));
  await assert.rejects(acceptMention(db, mention), PersistenceConflict);
  await assert.rejects(acceptObserverEvent(db, observer, slackTeamId), PersistenceConflict);
  await db.update(channelMappings).set({ enabled: true }).where(and(eq(channelMappings.tenantId, tenantId), eq(channelMappings.channelId, channelId)));
  await assert.rejects(acceptObserverEvent(db, observer, "TOTHER"), PersistenceConflict);
  await assert.rejects(acceptObserverEvent(db, observer), PersistenceConflict);
  await db.update(tenants).set({ active: false }).where(eq(tenants.id, tenantId));
  await assert.rejects(acceptMention(db, mention), PersistenceConflict);
  await assert.rejects(acceptObserverEvent(db, observer, slackTeamId), PersistenceConflict);
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, tenantId))).length, 0);
  assert.equal((await db.select().from(inbox).where(eq(inbox.tenantId, tenantId))).length, 0);
  assert.equal((await db.select().from(observedEvents).where(eq(observedEvents.tenantId, tenantId))).length, 0);
});

async function executionJobFixture() {
  const { tenantId, channelId, slackTeamId } = await newTenant();
  const { jobId } = await acceptObserverEvent(db, createObserverEventInput({ tenantId, source: "slack", providerEventId: `Ev-${randomUUID()}`, eventType: "message", channelId, threadTs: "1710000000.000001", messageTs: "1710000000.000002", actorId: "U-test", rawBody: "{}" }), slackTeamId);
  const input = { tenantId, jobId, taskId: "signal.observe-event", runId: "run-owner" };
  const dispatch = await claimOutboxDispatch(db, input);
  assert.ok(dispatch);
  await markOutboxDispatched(db, { ...dispatch, triggerRunId: input.runId });
  return input;
}

test("outbox execution owners exclude duplicate runs and fence completion", async () => {
  const input = await executionJobFixture();
  const claims = await Promise.all([claimOutboxExecution(db, input), claimOutboxExecution(db, input)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean)!;
  assert.equal(await finishOutboxExecution(db, { ...claim, runId: "other-run", state: "SUCCEEDED" }), false);
  assert.equal(await finishOutboxExecution(db, { ...claim, fencingToken: claim.fencingToken + 1, state: "SUCCEEDED" }), false);
  assert.equal(await finishOutboxExecution(db, { ...claim, state: "SUCCEEDED" }), true);
  assert.equal(await claimOutboxExecution(db, input), null);
  assert.equal(await claimOutboxExecution(db, { ...input, tenantId: "other-tenant" }), null);
});

test("outbox execution recovery waits for lease and terminal owner then advances one retry generation", async () => {
  const input = await executionJobFixture();
  const claim = await claimOutboxExecution(db, input);
  assert.ok(claim);
  assert.equal(await finishOutboxExecution(db, { ...claim, state: "FAILED", errorCode: "safe_failure" }), true);
  assert.equal((await listRecoverableOutboxExecutions(db)).some((job) => job.jobId === input.jobId), false);
  await db.update(outbox).set({ executionLeaseExpiresAt: new Date(Date.now() - 1000) }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
  const candidate = (await listRecoverableOutboxExecutions(db)).find((job) => job.jobId === input.jobId)!;
  assert.ok(candidate);
  assert.equal(await recoverOutboxExecution(db, candidate, "active"), "wait");
  assert.equal(await recoverOutboxExecution(db, candidate, null), "wait");
  assert.equal(await recoverOutboxExecution(db, candidate, "failed"), "retry");
  assert.equal(await recoverOutboxExecution(db, candidate, "failed"), "wait");
  assert.equal(await finishOutboxExecution(db, { ...claim, state: "SUCCEEDED" }), false);
  assert.equal(await claimOutboxDispatch(db, input), null);
  await db.update(outbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
  const dispatch = await claimOutboxDispatch(db, input);
  assert.equal(dispatch?.retryGeneration, 1);
  assert.ok(dispatch);
  assert.equal(await markOutboxDispatched(db, { ...dispatch, triggerRunId: "run-next" }), true);
  assert.equal(await claimOutboxExecution(db, input), null);
  const next = await claimOutboxExecution(db, { ...input, runId: "run-next" });
  assert.ok(next);
  assert.equal(await finishOutboxExecution(db, { ...next, state: "SUCCEEDED" }), true);
});

test("dispatched jobs that never started recover only after verified terminality", async () => {
  const input = await executionJobFixture();
  await db.update(outbox).set({ dispatchedAt: new Date(Date.now() - 360_000) }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
  const candidate = (await listRecoverableOutboxExecutions(db)).find((row) => row.jobId === input.jobId)!;
  assert.ok(candidate);
  assert.equal(await recoverOutboxExecution(db, candidate, null), "wait");
  assert.equal(await recoverOutboxExecution(db, candidate, "active"), "wait");
  assert.equal(await recoverOutboxExecution(db, candidate, "failed"), "retry");
  const [row] = await db.select().from(outbox).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
  assert.equal(row.executionState, "READY");
  assert.equal(row.retryGeneration, 1);
});

test("uncertain mutations recover through read-only reconciliation with no execute retry", async () => {
  const operation = await seedClaimedOperation();
  const [job] = await db.select().from(outbox).where(and(eq(outbox.tenantId, operation.tenantId), eq(outbox.taskId, "signal.execute-operation")));
  const owner = await claimOutboxExecution(db, { tenantId: operation.tenantId, jobId: job.id, taskId: job.taskId, runId: operation.attemptId });
  assert.ok(owner);
  await recordUnknownResult(db, { ...operation, errorCode: "response_lost" });
  await finishOutboxExecution(db, { ...owner, state: "FAILED" });
  await db.update(outbox).set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) }).where(and(eq(outbox.tenantId, operation.tenantId), eq(outbox.id, job.id)));
  const candidate = (await listRecoverableOutboxExecutions(db)).find((row) => row.jobId === job.id)!;
  assert.equal(await recoverOutboxExecution(db, candidate, "failed"), "reconcile");
  const jobs = await db.select().from(outbox).where(eq(outbox.tenantId, operation.tenantId));
  assert.equal(jobs.filter((row) => row.taskId === "signal.execute-operation").length, 1);
  assert.equal(jobs.filter((row) => row.taskId === "signal.reconcile-operation").length, 1);
  assert.equal(jobs.find((row) => row.id === job.id)?.retryGeneration, 0);
  assert.equal((await db.select().from(operations).where(eq(operations.tenantId, operation.tenantId)))[0].state, "UNKNOWN");
});

test("a possibly delivered proposal card becomes UNKNOWN and is never automatically reposted", async () => {
  const proposal = await seedProposal();
  const input = { tenantId: proposal.tenantId, jobId: randomUUID(), taskId: "signal.notify-slack", runId: "run-notice" };
  await db.insert(outbox).values({ tenantId: input.tenantId, id: input.jobId, taskId: input.taskId, proposalId: proposal.proposalId });
  const owner = await claimOutboxExecution(db, input);
  assert.ok(owner);
  await db.update(proposals).set({ notificationState: "SENDING" }).where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, proposal.proposalId)));
  await db.update(outbox).set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) }).where(and(eq(outbox.tenantId, input.tenantId), eq(outbox.id, input.jobId)));
  const candidate = (await listRecoverableOutboxExecutions(db)).find((row) => row.jobId === input.jobId)!;
  assert.equal(await recoverOutboxExecution(db, candidate, "failed"), "block");
  assert.equal(await claimOutboxExecution(db, input), null);
  assert.equal((await db.select().from(proposals).where(eq(proposals.tenantId, input.tenantId)))[0].notificationState, "UNKNOWN");
});

test("result notifications bind the exact proposal message and persist observed assignments", async () => {
  const operation = await seedClaimedOperation();
  await db.update(proposals).set({ notificationState: "SENT", notificationMessageTs: "1710000000.000100" }).where(and(eq(proposals.tenantId, operation.tenantId), eq(proposals.id, operation.proposalId)));
  await db.execute(sql`update threads set notification_message_ts = '1710000000.999999' where tenant_id = ${operation.tenantId}`);
  assert.ok(await recordSuccessfulResult(db, { ...operation, externalId: "123", externalIssueNumber: 123, externalUrl: "https://github.com/signal-test/fixtures/issues/123", actualAssignees: ["actual-owner"], assigneeMismatch: true }));
  const notification = await loadNotificationContext(db, operation);
  assert.ok(notification);
  assert.equal(notification.messageTs, "1710000000.000100");
  assert.deepEqual(notification.actualAssignees, ["actual-owner"]);
  assert.equal(notification.assigneeMismatch, true);
  assert.deepEqual(notification.context, { tenantId: operation.tenantId, operationId: operation.operationId, proposalId: operation.proposalId, channelId: operation.channelId, messageTs: notification.messageTs });
  assert.equal(await loadNotificationContext(db, { ...operation, tenantId: "other" }), null);
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
  const { tenantId, channelId, slackTeamId } = await newTenant();
  const input = {
    tenantId,
    slackEventId: `event-${randomUUID()}`,
    slackTeamId,
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
  const { tenantId, channelId, slackTeamId } = await newTenant();
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
  const first = await acceptObserverEvent(db, input, slackTeamId);
  const second = await acceptObserverEvent(db, input, slackTeamId);
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
  const { tenantId, channelId, slackTeamId } = await newTenant();
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
  }), slackTeamId);
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
  const binding = await reviewedBinding(proposal);
  const results = await Promise.all([approveProposal(db, binding), approveProposal(db, binding)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await db.select().from(proposals).where(and(eq(proposals.tenantId, proposal.tenantId), eq(proposals.id, proposal.proposalId))))[0]?.state, "APPROVED");
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, proposal.tenantId))).length, 1);
});

test("concurrent mutation claims fence to one owner and result enqueues notification", async () => {
  const proposal = await seedProposal();
  await approveProposal(db, await reviewedBinding(proposal));
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
    await db.execute(sql`delete from slack_reviews where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from operations where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from proposals where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from snapshots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from inbox where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from threads where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from approvers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from channel_mappings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from identity_mappings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  }
  await pool.end();
});
