import assert, { AssertionError } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client.ts";
import * as tables from "../../src/db/schema.ts";
import type { ViewerTenant } from "../../src/lib/tenant-context.ts";

type Resolve = (specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => ResolveFnOutput) => ResolveFnOutput;
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only" ? { url: "data:text/javascript,export {};", shortCircuit: true } : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

if (!process.env.DATABASE_URL) {
  test("Task 4 connection repository integration", { skip: "NOT RUN: DATABASE_URL is absent" }, () => {});
} else {
  const scopedUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  let namespace: string | undefined;
  try { namespace = new URL(scopedUrl).searchParams.get("options")?.match(/^-c search_path=(signal_test_[a-f0-9]{32})$/)?.[1]; }
  catch { throw new Error("Task 4 integration configuration is invalid"); }
  if (!namespace) throw new Error("Task 4 requires the isolated integration runner");
  const { db, pool } = createDb(scopedUrl);
  const { createConnectionRepository } = await import("../../src/db/connection-repository.ts");
  const { createOAuthStateService } = await import("../../src/lib/oauth-state.ts");
  const { sealConnectionSecret, openConnectionSecret } = await import("../../src/lib/connection-crypto.ts");
  const { tenants, tenantMemberships, providerConnections, oauthStates, channelMappings, audit, inbox } = tables;
  const key = "ab".repeat(32);
  const token = "synthetic-slack-token";

  before(async () => {
    try {
      const result = await db.execute<{ namespace: string }>(sql`select current_schema() as namespace`);
      assert.equal(result.rows[0]?.namespace, namespace);
      // The coordinator must register 0010 before invoking the standard runner.
      // This test never silently migrates application or shared tables.
      await db.select().from(providerConnections).limit(0);
      await db.select().from(oauthStates).limit(0);
    } catch { throw new Error("Task 4 requires verified isolation and registered provider migrations"); }
  });
  after(async () => { try { await pool.end(); } catch { throw new Error("Task 4 fixture cleanup failed safely"); } });

  function integration(name: string, work: () => Promise<void>) {
    test(`Task 4 ${name}`, { timeout: 30_000 }, async () => {
      try { await work(); } catch (error) {
        if (error instanceof AssertionError) throw error;
        throw new Error("Task 4 synthetic connection check failed safely");
      }
    });
  }

  async function fixture() {
    const viewer: ViewerTenant = { tenantId: randomUUID(), subject: `auth0|${randomUUID()}`, role: "OWNER" };
    await db.insert(tenants).values({ id: viewer.tenantId });
    await db.insert(tenantMemberships).values({ tenantId: viewer.tenantId, id: randomUUID(), auth0Subject: viewer.subject, role: viewer.role });
    const channelId = `channel-${randomUUID()}`;
    await db.insert(channelMappings).values({ tenantId: viewer.tenantId, channelId, repositoryId: "repo-1", repositoryOwner: "fixture", repositoryName: "example", installationId: "installation-1" });
    // Only the verified-session boundary is synthetic; all membership checks,
    // transactions, constraints, and state transitions below use PostgreSQL.
    const repository = (authority: ViewerTenant | null = viewer) => createConnectionRepository({ resolveViewerTenant: async () => authority, getEncryptionKey: () => key });
    const repo = repository();
    const service = createOAuthStateService({
      resolveViewerTenant: async () => viewer, getEncryptionKey: () => key,
      store: { save: (row) => repo.storeOAuthState(db, row), read: (query) => repo.readOAuthState(db, query), consume: (query) => repo.takeOAuthState(db, query) },
    });
    const slack = { provider: "slack" as const, externalAccountId: "team-1", botUserId: "bot-1", displayName: "Fixture workspace", encryptedSecret: sealConnectionSecret(token, key), scopes: ["chat:write", "app_mentions:read"] };
    const github = { provider: "github" as const, externalAccountId: "account-1", installationId: "installation-1", displayName: "Fixture account", scopes: ["issues:write"] };
    const stateInput = { ...viewer, provider: "slack" as const, returnTo: "/settings" };
    const callback = { subject: viewer.subject, provider: "slack" as const };
    return { viewer, repo, repository, service, slack, github, channelId, stateInput, callback };
  }

  integration("upsert is tenant/provider unique, encrypted, and returns only safe fields", async () => {
    const { viewer, repo, slack, github } = await fixture();
    const results = await Promise.all(Array.from({ length: 4 }, () => repo.upsertProviderConnection(db, slack)));
    assert.equal(new Set(results.map((row) => row.connectionId)).size, 1);
    const createdAt = results[0].createdAt;
    const updated = await repo.upsertProviderConnection(db, { ...slack, displayName: "Updated name" });
    assert.equal(updated.connectionId, results[0].connectionId);
    assert.deepEqual(updated.createdAt, createdAt);
    assert.equal(updated.status, "ACTIVE");
    assert.equal(updated.displayName, "Updated name");
    const visible = JSON.stringify(updated);
    for (const hidden of [token, slack.encryptedSecret, key, "encryptedSecret", viewer.subject]) assert.equal(visible.includes(hidden), false);
    const [stored] = await db.select().from(providerConnections).where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, "slack")));
    assert.equal(openConnectionSecret(stored.encryptedSecret!, key), token);
    assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, viewer.tenantId)), 1);
    const installed = await repo.upsertProviderConnection(db, github);
    assert.equal(installed.installationId, "installation-1");
    assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, viewer.tenantId)), 2);
  });

  integration("browser tenant/role/subject fields cannot select or elevate authority", async () => {
    const a = await fixture();
    const b = await fixture();
    await a.repo.upsertProviderConnection(db, { ...a.slack, tenantId: b.viewer.tenantId, subject: b.viewer.subject, role: "OWNER", viewer: b.viewer } as typeof a.slack);
    assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, b.viewer.tenantId)), 0);
    await b.repo.upsertProviderConnection(db, b.slack);
    await a.repo.revokeProviderConnection(db, { provider: "slack", tenantId: b.viewer.tenantId } as { provider: "slack" });
    const [other] = await db.select().from(providerConnections).where(eq(providerConnections.tenantId, b.viewer.tenantId));
    assert.equal(other.status, "ACTIVE");
    for (const denied of [null, { ...a.viewer, role: "MEMBER" as const }, { ...a.viewer, tenantId: b.viewer.tenantId }, { ...a.viewer, subject: "auth0|unknown" }]) {
      await assert.rejects(a.repository(denied).upsertProviderConnection(db, a.slack));
      await assert.rejects(a.repository(denied).revokeProviderConnection(db, { provider: "slack" }));
    }
  });

  for (const revoked of ["role", "membership", "tenant", "ambiguous"] as const) {
    integration(`fresh database authority rejects stale session after ${revoked} change`, async () => {
      const { viewer, repo, slack, service, stateInput, callback } = await fixture();
      const state = await service.createOAuthState(stateInput);
      if (revoked === "tenant") await db.update(tenants).set({ active: false }).where(eq(tenants.id, viewer.tenantId));
      else if (revoked === "ambiguous") {
        const other = await fixture();
        await db.insert(tenantMemberships).values({ tenantId: other.viewer.tenantId, id: randomUUID(), auth0Subject: viewer.subject, role: "OWNER" });
      } else await db.update(tenantMemberships).set(revoked === "role" ? { role: "MEMBER" } : { active: false }).where(eq(tenantMemberships.tenantId, viewer.tenantId));
      await assert.rejects(repo.upsertProviderConnection(db, slack));
      await assert.rejects(repo.revokeProviderConnection(db, { provider: "slack" }));
      await assert.rejects(service.consumeOAuthState(state, callback));
      assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, viewer.tenantId)), 0);
    });
  }

  integration("persisted ADMIN can manage connections without granting GitHub personal-token authority", async () => {
    const { viewer, repository, github, slack } = await fixture();
    await db.update(tenantMemberships).set({ role: "ADMIN" }).where(eq(tenantMemberships.tenantId, viewer.tenantId));
    const repo = repository({ ...viewer, role: "ADMIN" });
    assert.equal((await repo.upsertProviderConnection(db, github)).status, "ACTIVE");
    await assert.rejects(repo.upsertProviderConnection(db, { ...github, encryptedSecret: slack.encryptedSecret } as typeof github));
    await assert.rejects(repo.upsertProviderConnection(db, { ...slack, encryptedSecret: token }));
    await assert.rejects(repo.upsertProviderConnection(db, { ...slack, encryptedSecret: sealConnectionSecret(token, "cd".repeat(32)) }));
  });

  integration("database state consumption admits exactly one concurrent callback and retains its marker", async () => {
    const { viewer, service, stateInput, callback } = await fixture();
    const state = await service.createOAuthState(stateInput);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.consumeOAuthState(state, callback)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    await assert.rejects(service.consumeOAuthState(state, callback));
    const [record] = await db.select().from(oauthStates).where(eq(oauthStates.tenantId, viewer.tenantId));
    assert.ok(record.consumedAt);
    assert.equal(JSON.stringify(record).includes(state), false);
  });

  integration("state checks subject, provider, tenant and database expiry before callback admission", async () => {
    const a = await fixture();
    const b = await fixture();
    const state = await a.service.createOAuthState(a.stateInput);
    await assert.rejects(b.service.consumeOAuthState(state, b.callback));
    await assert.rejects(a.service.consumeOAuthState(state, { ...a.callback, provider: "github" }));
    await assert.rejects(a.service.consumeOAuthState(state, { ...a.callback, subject: b.viewer.subject }));
    await assert.rejects(a.service.createOAuthState({ ...a.stateInput, tenantId: b.viewer.tenantId }));
    assert.equal((await a.service.consumeOAuthState(state, a.callback)).tenantId, a.viewer.tenantId);
    const expired = await a.service.createOAuthState(a.stateInput);
    await db.update(oauthStates).set({ createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) }).where(and(eq(oauthStates.tenantId, a.viewer.tenantId), sql`${oauthStates.consumedAt} is null`));
    await assert.rejects(a.service.consumeOAuthState(expired, a.callback));
  });

  for (const provider of ["slack", "github"] as const) {
    integration(`${provider} revocation disables only its tenant mappings and preserves audit/replay records`, async () => {
      const a = await fixture();
      const b = await fixture();
      await a.repo.upsertProviderConnection(db, provider === "slack" ? a.slack : a.github);
      await db.update(channelMappings).set({ enabled: true }).where(eq(channelMappings.tenantId, a.viewer.tenantId));
      const stateInput = { ...a.stateInput, provider };
      const callback = { ...a.callback, provider };
      const consumed = await a.service.createOAuthState(stateInput);
      await a.service.consumeOAuthState(consumed, callback);
      const pending = await a.service.createOAuthState(stateInput);
      const event = { tenantId: a.viewer.tenantId, id: randomUUID(), slackEventId: randomUUID(), channelId: a.channelId, threadTs: "1.1", messageTs: "1.1", actorSlackId: "fixture-actor" };
      await db.insert(inbox).values(event);
      const beforeAudit = await db.$count(audit, eq(audit.tenantId, a.viewer.tenantId));
      const [beforeTenant] = await db.select().from(tenants).where(eq(tenants.id, a.viewer.tenantId));
      const revoked = await a.repo.revokeProviderConnection(db, { provider });
      assert.equal(revoked.status, "REVOKED");
      const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.tenantId, a.viewer.tenantId));
      assert.equal(connection.encryptedSecret, null);
      assert.ok(connection.revokedAt);
      const [own] = await db.select().from(channelMappings).where(eq(channelMappings.tenantId, a.viewer.tenantId));
      const [other] = await db.select().from(channelMappings).where(eq(channelMappings.tenantId, b.viewer.tenantId));
      assert.equal(own.enabled, false);
      assert.equal(other.enabled, true);
      assert.equal(await db.$count(oauthStates, eq(oauthStates.tenantId, a.viewer.tenantId)), 2);
      assert.equal(await db.$count(audit, eq(audit.tenantId, a.viewer.tenantId)), beforeAudit + 1);
      assert.equal(await db.$count(inbox, eq(inbox.tenantId, a.viewer.tenantId)), 1);
      await assert.rejects(db.insert(inbox).values({ ...event, id: randomUUID() }));
      await assert.rejects(a.service.consumeOAuthState(pending, callback));
      await assert.rejects(a.service.consumeOAuthState(consumed, callback));
      assert.deepEqual(await a.repo.revokeProviderConnection(db, { provider }), revoked);
      const [afterTenant] = await db.select().from(tenants).where(eq(tenants.id, a.viewer.tenantId));
      assert.equal(afterTenant.configVersion, beforeTenant.configVersion + 1);
      await a.repo.upsertProviderConnection(db, provider === "slack" ? a.slack : a.github);
      const [stillDisabled] = await db.select().from(channelMappings).where(eq(channelMappings.tenantId, a.viewer.tenantId));
      assert.equal(stillDisabled.enabled, false);
    });
  }

  integration("audit failure rolls back revocation, mappings, config version and state invalidation", async () => {
    const { viewer, repo, slack, service, stateInput, callback } = await fixture();
    await repo.upsertProviderConnection(db, slack);
    await db.update(channelMappings).set({ enabled: true }).where(eq(channelMappings.tenantId, viewer.tenantId));
    const state = await service.createOAuthState(stateInput);
    const [beforeTenant] = await db.select().from(tenants).where(eq(tenants.id, viewer.tenantId));
    await db.execute(sql`alter table ${audit} add constraint task4_force_rollback check (not (tenant_id = ${sql.raw(`'${viewer.tenantId}'`)} and to_state = 'REVOKED'))`);
    try {
      await assert.rejects(repo.revokeProviderConnection(db, { provider: "slack" }));
      const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.tenantId, viewer.tenantId));
      const [mapping] = await db.select().from(channelMappings).where(eq(channelMappings.tenantId, viewer.tenantId));
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, viewer.tenantId));
      assert.equal(connection.status, "ACTIVE");
      assert.equal(mapping.enabled, true);
      assert.equal(tenant.configVersion, beforeTenant.configVersion);
      assert.equal((await service.consumeOAuthState(state, callback)).tenantId, viewer.tenantId);
    } finally { await db.execute(sql`alter table ${audit} drop constraint task4_force_rollback`); }
  });

  integration("composite membership keys reject orphan and cross-tenant connection/state records", async () => {
    const a = await fixture();
    const b = await fixture();
    await a.repo.upsertProviderConnection(db, a.slack);
    const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.tenantId, a.viewer.tenantId));
    await assert.rejects(db.insert(providerConnections).values({ ...connection, id: randomUUID() }));
    await assert.rejects(db.insert(providerConnections).values({ ...connection, tenantId: b.viewer.tenantId }));
    await assert.rejects(db.insert(providerConnections).values({ ...connection, tenantId: randomUUID() }));
    await a.service.createOAuthState(a.stateInput);
    const [state] = await db.select().from(oauthStates).where(eq(oauthStates.tenantId, a.viewer.tenantId));
    await assert.rejects(db.insert(oauthStates).values({ ...state, tenantId: b.viewer.tenantId }));
    await assert.rejects(db.insert(oauthStates).values({ ...state, provider: "unknown" as "slack", stateHash: "a".repeat(64) }));
  });
}
