import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import {
  acceptMention,
  approveProposal,
  claimMutation,
  createProposal,
  insertChannelMapping,
  insertSnapshot,
  insertTenant,
  insertThread,
  recordSuccessfulResult,
  PersistenceConflict,
} from "../../src/db/repositories";
import { inbox, operations, outbox, proposals } from "../../src/db/schema";
import { prepareMutation } from "../../src/domain/contracts";

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
    externalUrl: "https://github.com/signal-test/fixtures/issues/123",
  });
  assert.ok(result);
  assert.equal((await db.select().from(operations).where(eq(operations.tenantId, proposal.tenantId)))[0]?.state, "SUCCEEDED");
  assert.equal((await db.select().from(outbox).where(eq(outbox.tenantId, proposal.tenantId))).length, 2);
});

after(async () => {
  for (const tenantId of tenantIds) {
    await db.execute(sql`delete from audit where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from outbox where tenant_id = ${tenantId}`);
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
