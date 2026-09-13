import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { createDb, type SignalDb } from "../../src/db/client";
import { PersistenceConflict } from "../../src/db/errors";
import {
  beginProposalNotification, createProposal, findStoredAnalyzedProposal, loadInboxContext,
  loadProposalNotification, markProposalNotificationUnknown, persistAnalyzedProposal,
  recordProposalNotificationSent, type AnalyzedProposalInput,
} from "../../src/db/proposal-persistence";
import { channelMappings, inbox, operations, outbox, proposals, snapshots, tenants, threads } from "../../src/db/schema";
import { actionFingerprint, canonicalJson, payloadHash, prepareMutation, type Analysis, type Mutation } from "../../src/domain/contracts";
import type { SourceMessage } from "../../src/services/analyze";
import { renderPersistedProposalCard } from "../../src/services/proposal-card";

const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A04 persistence isolated database is required");
const fixtureUrl = new URL(databaseUrl);
fixtureUrl.searchParams.set("options", `${fixtureUrl.searchParams.get("options") ?? ""} -c lock_timeout=5000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000`.trim());
const { db, pool } = createDb(fixtureUrl.toString());

before(async () => {
  try {
    const result = await db.execute<{ namespace: string }>(sql`select current_schema() as namespace`);
    if (!/^signal_test_[a-f0-9]{32}$/.test(result.rows[0]?.namespace ?? "")) throw new Error();
  } catch { throw new Error("A04 persistence requires the disposable-schema runner"); }
});
after(async () => { await pool.end(); });

function fixtureTest(name: string, work: () => Promise<void>): void {
  test(`A04 persistence ${name}`, { timeout: 60_000 }, async () => {
    try { await work(); }
    catch (error) {
      if (error instanceof assert.AssertionError || error instanceof PersistenceConflict) throw error;
      // Never print a driver error: it can contain SQL parameters or credentials.
      throw new Error("A04 persistence fixture failed unexpectedly");
    }
  });
}

interface Fixture { tenantId: string; channelId: string; threadId: string; threadTs: string; inboxId: string; repoId: string }

async function fixture(): Promise<Fixture> {
  const tenantId = `a04-${randomUUID()}`;
  const channelId = `C${randomUUID().replaceAll("-", "")}`;
  const repoId = `repo-${randomUUID()}`;
  const threadId = randomUUID();
  const inboxId = randomUUID();
  const threadTs = "1710000000.000001";
  await db.insert(tenants).values({ id: tenantId, slackTeamId: `T${randomUUID()}`, configVersion: 7 });
  await db.insert(channelMappings).values({ tenantId, channelId, repositoryId: repoId, repositoryOwner: "signal-test", repositoryName: "fixtures", installationId: "installation-fixture" });
  await db.insert(threads).values({ tenantId, id: threadId, channelId, threadTs });
  await db.insert(inbox).values({ tenantId, id: inboxId, slackEventId: randomUUID(), channelId, threadTs, messageTs: threadTs, actorSlackId: "U123" });
  return { tenantId, channelId, threadId, threadTs, inboxId, repoId };
}

function snapshotHash(messages: SourceMessage[]): string {
  return createHash("sha256").update(canonicalJson(messages.map(({ ts, user, text, permalink, editedAt = null }) => ({ ts, user, text, permalink, editedAt }))), "utf8").digest("hex");
}

function proposalInput(f: Fixture, version = 1, progress = false): AnalyzedProposalInput {
  const text = version === 1 ? "Track the migration" : `Verified progress step ${version}`;
  const messages: SourceMessage[] = [{ ts: `1710000000.00000${version}`, user: "U123", text, permalink: `https://slack.example/archives/${f.channelId}/p171000000000000${version}` }];
  const analysis: Analysis = { decisions: [{ text, evidence: [{ messageTs: messages[0].ts, permalink: messages[0].permalink }] }], tasks: [], blockers: [], uncertainties: [] };
  const operationId = randomUUID();
  const base = { repoId: f.repoId, owner: "signal-test", repo: "fixtures", body: `${text}\nEvidence: ${messages[0].permalink}` };
  const mutation = prepareMutation(progress ? { ...base, kind: "ADD_PROGRESS_COMMENT", issueId: "4200", issueNumber: 42 } : { ...base, kind: "CREATE_ISSUE", title: text, assignees: [] }, operationId);
  const hash = snapshotHash(messages);
  const destination = progress ? { repoId: f.repoId, issueId: "4200", issueNumber: 42 } : { repoId: f.repoId };
  return {
    tenantId: f.tenantId, threadId: f.threadId, version, operationId, mutation, analysis,
    snapshot: { content: messages, snapshotHash: hash, expiresAt: new Date(Date.now() + 20 * 60_000) },
    expiresAt: new Date(Date.now() + 20 * 60_000),
    actionFingerprint: actionFingerprint({ tenantId: f.tenantId, channelId: f.channelId, threadTs: f.threadTs, snapshotHash: hash, kind: mutation.kind, destination }),
    payloadHash: payloadHash({ schemaVersion: 1, tenantId: f.tenantId, operationId, version, mutation }),
  };
}

async function counts(tenantId: string) {
  const count = async (table: typeof snapshots | typeof proposals | typeof operations | typeof outbox) => Number((await db.select({ value: sql<number>`count(*)` }).from(table).where(eq(table.tenantId, tenantId)))[0].value);
  return { snapshots: await count(snapshots), proposals: await count(proposals), operations: await count(operations), outbox: await count(outbox) };
}

async function loadRows(f: Fixture) {
  return db.select().from(proposals).where(eq(proposals.tenantId, f.tenantId)).orderBy(proposals.version);
}

async function settle(f: Fixture, proposalId: string, operationId: string, state: string): Promise<void> {
  await db.update(proposals).set({ state: "APPROVED" }).where(and(eq(proposals.tenantId, f.tenantId), eq(proposals.id, proposalId)));
  await db.update(operations).set({ state }).where(and(eq(operations.tenantId, f.tenantId), eq(operations.id, operationId)));
  if (state === "SUCCEEDED") await db.update(threads).set({ linkedIssueId: "4200", linkedIssueNumber: 42, activeOperationId: null }).where(and(eq(threads.tenantId, f.tenantId), eq(threads.id, f.threadId)));
}

fixtureTest("atomically stores analysis, immutable payload, snapshot, operation and proposal notification", async () => {
  const f = await fixture();
  const input = proposalInput(f);
  const saved = await persistAnalyzedProposal(db, input);
  assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 1 });
  const [row] = await loadRows(f);
  assert.equal(row.configVersion, 7);
  assert.equal(row.payloadHash, input.payloadHash);
  assert.equal(canonicalJson(row.mutation) === canonicalJson(input.mutation), true);
  const restored = await findStoredAnalyzedProposal(db, input);
  assert.ok(restored);
  assert.equal(restored.proposalId, saved.proposalId);
  assert.equal(restored.version, 1);
  assert.equal(canonicalJson(restored.analysis) === canonicalJson(input.analysis), true);
  const [job] = await db.select().from(outbox).where(eq(outbox.tenantId, f.tenantId));
  assert.equal(job.taskId, "signal.notify-slack");
  assert.equal(job.proposalId, saved.proposalId);
  assert.equal(job.operationId, null);
  const notification = await loadProposalNotification(db, { tenantId: f.tenantId, proposalId: saved.proposalId });
  assert.ok(notification);
  assert.equal(notification.channelId, f.channelId);
  assert.equal(notification.threadTs, f.threadTs);
  assert.equal(notification.messageTs, null);
  assert.equal(notification.notificationState, "PENDING");
  assert.equal(renderPersistedProposalCard(notification).blocks.some((block) => block.type === "actions"), true);
});

fixtureTest("concurrent exact fingerprints return the same stored winner without duplicate rows", async () => {
  const f = await fixture();
  const left = proposalInput(f);
  const right = proposalInput(f);
  const results = await Promise.all([persistAnalyzedProposal(db, left), persistAnalyzedProposal(db, right)]);
  assert.equal(results[0].proposalId, results[1].proposalId);
  assert.equal(results[0].operationId, results[1].operationId);
  const duplicate = results.find((result) => result.existing)?.existing;
  assert.ok(duplicate);
  assert.equal(duplicate.operationId, results[0].operationId);
  assert.equal(duplicate.payloadHash, results[0].payloadHash);
  assert.equal(duplicate.version, 1);
  assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 1 });
  const replay = await persistAnalyzedProposal(db, { ...right, version: 99 });
  assert.equal(replay.existing?.version, 1);
  assert.equal(canonicalJson(replay.existing?.mutation) === canonicalJson(duplicate.mutation), true);
});

fixtureTest("concurrent distinct proposals serialize the next version", async () => {
  const f = await fixture();
  const left = proposalInput(f);
  const right = proposalInput(f, 1, true);
  const outcomes = await Promise.allSettled([persistAnalyzedProposal(db, left), persistAnalyzedProposal(db, right)]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected" && result.reason instanceof PersistenceConflict).length, 1);
  assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 1 });
});

fixtureTest("supersedes only a pending READY predecessor and makes its unused operation STALE", async () => {
  const f = await fixture();
  const first = await persistAnalyzedProposal(db, proposalInput(f));
  const second = await persistAnalyzedProposal(db, proposalInput(f, 2));
  const rows = await loadRows(f);
  assert.equal(rows[0].state, "SUPERSEDED");
  assert.equal(rows[1].state, "PENDING");
  const ops = await db.select().from(operations).where(eq(operations.tenantId, f.tenantId));
  assert.equal(ops.find((row) => row.id === first.operationId)?.state, "STALE");
  assert.equal(ops.find((row) => row.id === second.operationId)?.state, "READY");
  const [thread] = await db.select().from(threads).where(and(eq(threads.tenantId, f.tenantId), eq(threads.id, f.threadId)));
  assert.equal(thread.activeOperationId, second.operationId);
  assert.deepEqual(await counts(f.tenantId), { snapshots: 2, proposals: 2, operations: 2, outbox: 2 });
});

fixtureTest("approved READY, SENDING and UNKNOWN operations block new proposals but allow exact replay", async () => {
  for (const state of ["READY", "SENDING", "UNKNOWN"]) {
    const f = await fixture();
    const input = proposalInput(f);
    const saved = await persistAnalyzedProposal(db, input);
    await settle(f, saved.proposalId, saved.operationId, state);
    await assert.rejects(persistAnalyzedProposal(db, proposalInput(f, 2, true)), PersistenceConflict);
    const replay = await persistAnalyzedProposal(db, input);
    assert.equal(replay.operationId, saved.operationId);
    assert.ok(replay.existing);
    assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 1 });
  }
});

fixtureTest("settled operations permit the next progress version and successful snapshots feed context", async () => {
  for (const state of ["SUCCEEDED", "FAILED", "STALE"]) {
    const f = await fixture();
    const input = proposalInput(f);
    const saved = await persistAnalyzedProposal(db, input);
    await settle(f, saved.proposalId, saved.operationId, state);
    const context = await loadInboxContext(db, f);
    assert.ok(context);
    assert.equal(context.nextVersion, 2);
    assert.equal(context.repository.repoId, f.repoId);
    if (state === "SUCCEEDED") {
      assert.deepEqual(context.linkedIssue, { issueId: "4200", issueNumber: 42 });
      assert.equal(canonicalJson(context.previousSourceMessages) === canonicalJson(input.snapshot.content), true);
      await assert.rejects(persistAnalyzedProposal(db, proposalInput(f, 2)), PersistenceConflict);
    } else assert.equal(context.previousSourceMessages, undefined);
    const progress = await persistAnalyzedProposal(db, proposalInput(f, 2, true));
    assert.notEqual(progress.operationId, saved.operationId);
    const rows = await loadRows(f);
    assert.equal(rows[0].state, "APPROVED");
    assert.equal(rows[1].version, 2);
  }
});

function rejectNotificationInsert(database: SignalDb): SignalDb {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (work: Parameters<SignalDb["transaction"]>[0]) => target.transaction((tx) => work(new Proxy(tx, {
        get(transaction, key, transactionReceiver) {
          if (key !== "insert") return Reflect.get(transaction, key, transactionReceiver);
          return (table: Parameters<typeof tx.insert>[0]) => {
            if (table === outbox) throw new Error("fixture-private-driver-content");
            return transaction.insert(table);
          };
        },
      })));
    },
  });
}

fixtureTest("notification failure rolls back snapshot, supersession, operation and thread replacement", async () => {
  const f = await fixture();
  const first = await persistAnalyzedProposal(db, proposalInput(f));
  await assert.rejects(persistAnalyzedProposal(rejectNotificationInsert(db), proposalInput(f, 2)), (error: unknown) => error instanceof PersistenceConflict && !error.message.includes("fixture-private-driver-content") && !("cause" in error));
  assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 1 });
  assert.equal((await loadRows(f))[0].state, "PENDING");
  const [operation] = await db.select().from(operations).where(and(eq(operations.tenantId, f.tenantId), eq(operations.id, first.operationId)));
  const [thread] = await db.select().from(threads).where(and(eq(threads.tenantId, f.tenantId), eq(threads.id, f.threadId)));
  assert.equal(operation.state, "READY");
  assert.equal(thread.activeOperationId, first.operationId);
});

fixtureTest("exact repository identity, active nonshared mapping and positive tenant config are required", async () => {
  const f = await fixture();
  const input = proposalInput(f);
  for (const mutation of [{ ...input.mutation, repoId: "wrong" }, { ...input.mutation, owner: "other" }, { ...input.mutation, repo: "other" }]) await assert.rejects(persistAnalyzedProposal(db, { ...input, mutation, payloadHash: undefined }), PersistenceConflict);
  for (const patch of [{ enabled: false, shared: false }, { enabled: true, shared: true }]) {
    await db.update(channelMappings).set(patch).where(eq(channelMappings.tenantId, f.tenantId));
    await assert.rejects(persistAnalyzedProposal(db, input), PersistenceConflict);
  }
  await db.update(channelMappings).set({ enabled: true, shared: false }).where(eq(channelMappings.tenantId, f.tenantId));
  for (const patch of [{ active: false, configVersion: 7 }, { active: true, configVersion: 0 }]) {
    await db.update(tenants).set(patch).where(eq(tenants.id, f.tenantId));
    await assert.rejects(persistAnalyzedProposal(db, input), PersistenceConflict);
  }
  assert.deepEqual(await counts(f.tenantId), { snapshots: 0, proposals: 0, operations: 0, outbox: 0 });
});

fixtureTest("snapshot identity and hash reuse cannot cross tenant threads", async () => {
  const f = await fixture();
  const input = proposalInput(f);
  await persistAnalyzedProposal(db, input);
  const [snapshot] = await db.select().from(snapshots).where(eq(snapshots.tenantId, f.tenantId));
  const otherThreadId = randomUUID();
  const otherThreadTs = "1710000010.000001";
  await db.insert(threads).values({ tenantId: f.tenantId, id: otherThreadId, channelId: f.channelId, threadTs: otherThreadTs });
  const cross = { ...input, threadId: otherThreadId, actionFingerprint: actionFingerprint({ tenantId: f.tenantId, channelId: f.channelId, threadTs: otherThreadTs, snapshotHash: input.snapshot.snapshotHash, kind: "CREATE_ISSUE", destination: { repoId: f.repoId } }) };
  await assert.rejects(persistAnalyzedProposal(db, cross), PersistenceConflict);
  await assert.rejects(createProposal(db, { ...cross, snapshotId: snapshot.id, analysis: undefined }), PersistenceConflict);
  const otherTenant = await fixture();
  await assert.rejects(createProposal(db, { ...proposalInput(otherTenant), snapshotId: snapshot.id, analysis: undefined }), PersistenceConflict);
  assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 1 });
  assert.deepEqual(await counts(otherTenant.tenantId), { snapshots: 0, proposals: 0, operations: 0, outbox: 0 });
  assert.equal(await findStoredAnalyzedProposal(db, { ...input, threadId: otherThreadId }), null);
  assert.equal(await findStoredAnalyzedProposal(db, { ...input, tenantId: otherTenant.tenantId }), null);
});

fixtureTest("same-thread snapshot reuse creates no duplicate snapshot or expiry extension", async () => {
  const f = await fixture();
  const input = proposalInput(f);
  const created = await persistAnalyzedProposal(db, input);
  await settle(f, created.proposalId, created.operationId, "FAILED");
  const second = proposalInput(f, 2, true);
  second.snapshot = { ...input.snapshot, expiresAt: new Date(Date.now() + 25 * 60_000) };
  second.analysis = input.analysis;
  second.actionFingerprint = actionFingerprint({ tenantId: f.tenantId, channelId: f.channelId, threadTs: f.threadTs, snapshotHash: input.snapshot.snapshotHash, kind: "ADD_PROGRESS_COMMENT", destination: { repoId: f.repoId, issueId: "4200", issueNumber: 42 } });
  await persistAnalyzedProposal(db, second);
  const rows = await db.select().from(snapshots).where(eq(snapshots.tenantId, f.tenantId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].expiresAt.getTime(), input.snapshot.expiresAt.getTime());
});

fixtureTest("generic creation permits omitted analysis without inventing notification content", async () => {
  const f = await fixture();
  const snapshotId = randomUUID();
  await db.insert(snapshots).values({ tenantId: f.tenantId, id: snapshotId, threadId: f.threadId, content: { fixture: true }, snapshotHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
  const input = proposalInput(f);
  await createProposal(db, { ...input, analysis: undefined, snapshotId, mutation: { ...input.mutation, body: "Synthetic body\r\n<!-- signal-operation:spoofed -->" }, actionFingerprint: "generic-fixture" });
  assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 0 });
  const [row] = await loadRows(f);
  assert.equal(row.analysis, null);
  assert.equal(row.configVersion, 7);
  assert.equal((row.mutation as Mutation).body.includes("spoofed"), false);
  await assert.rejects(findStoredAnalyzedProposal(db, { ...input, actionFingerprint: "generic-fixture" }), PersistenceConflict);
});

fixtureTest("analyzed persistence rejects absent, empty or spoofed analysis before any insert", async () => {
  const f = await fixture();
  const input = proposalInput(f);
  for (const analysis of [null, undefined, { decisions: [], tasks: [], blockers: [], uncertainties: [] }, { ...input.analysis, decisions: [{ text: "Track the migration", evidence: [{ messageTs: "missing", permalink: "https://slack.example/missing" }] }] }]) {
    await assert.rejects(persistAnalyzedProposal(db, { ...input, analysis: analysis as unknown as Analysis }), PersistenceConflict);
  }
  await assert.rejects(persistAnalyzedProposal(db, { ...input, snapshot: { ...input.snapshot, snapshotHash: "wrong" } }), PersistenceConflict);
  await assert.rejects(persistAnalyzedProposal(db, { ...input, payloadHash: "wrong" }), PersistenceConflict);
  assert.deepEqual(await counts(f.tenantId), { snapshots: 0, proposals: 0, operations: 0, outbox: 0 });
});

fixtureTest("lookup validates raw immutable bytes and never repairs or regenerates redacted rows", async () => {
  const f = await fixture();
  const input = proposalInput(f);
  const saved = await persistAnalyzedProposal(db, input);
  const marker = `<!-- signal-operation:${saved.operationId} -->`;
  for (const mutation of [
    { redacted: true },
    { ...input.mutation, body: input.mutation.body.replaceAll("\n", "\r\n") },
    { ...input.mutation, body: input.mutation.body + "\n" },
    { ...input.mutation, body: input.mutation.body.replace(marker, "") },
    { ...input.mutation, body: `<!-- signal-operation:spoofed -->\n${input.mutation.body}` },
  ]) {
    // Even a freshly computed raw hash cannot legitimize a missing/duplicate marker or normalization.
    const hash = createHash("sha256").update(canonicalJson({ schemaVersion: 1, tenantId: f.tenantId, operationId: saved.operationId, version: 1, mutation })).digest("hex");
    await db.update(proposals).set({ mutation, payloadHash: hash }).where(and(eq(proposals.tenantId, f.tenantId), eq(proposals.id, saved.proposalId)));
    await assert.rejects(findStoredAnalyzedProposal(db, input), PersistenceConflict);
    await assert.rejects(persistAnalyzedProposal(db, input), PersistenceConflict);
  }
  await db.update(proposals).set({ mutation: input.mutation, payloadHash: saved.payloadHash, analysis: null }).where(and(eq(proposals.tenantId, f.tenantId), eq(proposals.id, saved.proposalId)));
  await assert.rejects(findStoredAnalyzedProposal(db, input), PersistenceConflict);
  await assert.rejects(persistAnalyzedProposal(db, input), PersistenceConflict);
  assert.deepEqual(await counts(f.tenantId), { snapshots: 1, proposals: 1, operations: 1, outbox: 1 });
});

fixtureTest("notification claim races and UNKNOWN never authorize a second first-post", async () => {
  const f = await fixture();
  const saved = await persistAnalyzedProposal(db, proposalInput(f));
  const key = { tenantId: f.tenantId, proposalId: saved.proposalId };
  const claims = await Promise.all([beginProposalNotification(db, key), beginProposalNotification(db, key)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await markProposalNotificationUnknown(db, key), true);
  assert.equal(await markProposalNotificationUnknown(db, key), false);
  assert.equal(await beginProposalNotification(db, key), false);
  assert.equal(await recordProposalNotificationSent(db, { ...key, messageTs: "1710000001.000001" }), false);
  const restored = await loadProposalNotification(db, key);
  assert.equal(restored?.notificationState, "UNKNOWN");
  assert.equal(restored?.messageTs, null);
});

fixtureTest("records a successful post once even if tenant configuration changed after sending", async () => {
  const f = await fixture();
  const saved = await persistAnalyzedProposal(db, proposalInput(f));
  const key = { tenantId: f.tenantId, proposalId: saved.proposalId };
  assert.equal(await recordProposalNotificationSent(db, { ...key, messageTs: "1710000001.000001" }), false);
  assert.equal(await beginProposalNotification(db, key), true);
  await db.update(tenants).set({ active: false, configVersion: 8 }).where(eq(tenants.id, f.tenantId));
  assert.equal(await recordProposalNotificationSent(db, { ...key, messageTs: "1710000001.000001" }), true);
  assert.equal(await recordProposalNotificationSent(db, { ...key, messageTs: "1710000002.000001" }), false);
  assert.equal(await markProposalNotificationUnknown(db, key), false);
  const [row] = await loadRows(f);
  assert.equal(row.notificationState, "SENT");
  assert.equal(row.notificationMessageTs, "1710000001.000001");
});

fixtureTest("notification material is tenant scoped and captured config must still match before posting", async () => {
  const f = await fixture();
  const saved = await persistAnalyzedProposal(db, proposalInput(f));
  const other = await fixture();
  const wrong = { tenantId: other.tenantId, proposalId: saved.proposalId };
  assert.equal(await loadProposalNotification(db, wrong), null);
  assert.equal(await beginProposalNotification(db, wrong), false);
  assert.equal(await markProposalNotificationUnknown(db, wrong), false);
  const key = { tenantId: f.tenantId, proposalId: saved.proposalId };
  await db.update(tenants).set({ configVersion: 8 }).where(eq(tenants.id, f.tenantId));
  await assert.rejects(loadProposalNotification(db, key), PersistenceConflict);
  await assert.rejects(beginProposalNotification(db, key), PersistenceConflict);
  assert.equal((await loadRows(f))[0].notificationState, "PENDING");
});

fixtureTest("inbox context uses the latest successful retained snapshot and omits expired source", async () => {
  const f = await fixture();
  const input = proposalInput(f);
  const first = await persistAnalyzedProposal(db, input);
  await settle(f, first.proposalId, first.operationId, "SUCCEEDED");
  await persistAnalyzedProposal(db, proposalInput(f, 2, true));
  const context = await loadInboxContext(db, f);
  assert.equal(context?.nextVersion, 3);
  assert.equal(canonicalJson(context?.previousSourceMessages) === canonicalJson(input.snapshot.content), true);
  const [row] = await loadRows(f);
  await db.update(snapshots).set({ expiresAt: new Date(Date.now() - 1_000), content: { retained: false } }).where(and(eq(snapshots.tenantId, f.tenantId), eq(snapshots.id, row.snapshotId)));
  const expired = await loadInboxContext(db, f);
  assert.equal(expired?.previousSourceMessages, undefined);
  assert.equal(expired?.nextVersion, 3);
  const other = await fixture();
  assert.equal(await loadInboxContext(db, { tenantId: other.tenantId, inboxId: f.inboxId }), null);
});
