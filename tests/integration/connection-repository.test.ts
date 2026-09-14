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
      store: { save: (row, sealPayload) => repo.storeOAuthState(db, row, sealPayload), read: (query) => repo.readOAuthState(db, query), consume: (query) => repo.takeOAuthState(db, query) },
    });
    const slack = { provider: "slack" as const, externalAccountId: "team-1", botUserId: "bot-1", displayName: "Fixture workspace", encryptedSecret: sealConnectionSecret(token, key), scopes: ["chat:write", "app_mentions:read"] };
    const github = { provider: "github" as const, externalAccountId: "account-1", installationId: "installation-1", displayName: "Fixture account", scopes: ["issues:write"] };
    const stateInput = { ...viewer, provider: "slack" as const, returnTo: "/settings" };
    const callback = { subject: viewer.subject, provider: "slack" as const };
    async function authorize<T extends { provider: "slack" | "github" }>(input: T) {
      const state = await service.createOAuthState({ ...stateInput, provider: input.provider });
      const { completion } = await service.consumeOAuthState(state, { ...callback, provider: input.provider });
      return { ...input, completion };
    }
    return { viewer, repo, repository, service, slack, github, channelId, stateInput, callback, authorize };
  }

  integration("upsert is tenant/provider unique, encrypted, and returns only safe fields", async () => {
    const { viewer, repo, slack, github, authorize } = await fixture();
    const attempts = await Promise.all(Array.from({ length: 4 }, () => authorize(slack)));
    const results = await Promise.allSettled(attempts.map((input) => repo.upsertProviderConnection(db, input)));
    const successful = results.filter((result) => result.status === "fulfilled");
    // The first write advances the tenant generation; competing old completions
    // cannot subsequently overwrite its newly established connection.
    assert.equal(successful.length, 1);
    const created = successful[0].value;
    const createdAt = created.createdAt;
    const updated = await repo.upsertProviderConnection(db, await authorize({ ...slack, displayName: "Updated name" }));
    assert.equal(updated.connectionId, created.connectionId);
    assert.deepEqual(updated.createdAt, createdAt);
    assert.equal(updated.status, "ACTIVE");
    assert.equal(updated.displayName, "Updated name");
    const visible = JSON.stringify(updated);
    for (const hidden of [token, slack.encryptedSecret, key, "encryptedSecret", viewer.subject]) assert.equal(visible.includes(hidden), false);
    const [stored] = await db.select().from(providerConnections).where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, "slack")));
    assert.equal(openConnectionSecret(stored.encryptedSecret!, key), token);
    assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, viewer.tenantId)), 1);
    const installed = await repo.upsertProviderConnection(db, await authorize(github));
    assert.equal(installed.installationId, "installation-1");
    assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, viewer.tenantId)), 2);
  });

  integration("browser tenant/role/subject fields cannot select or elevate authority", async () => {
    const a = await fixture();
    const b = await fixture();
    await a.repo.upsertProviderConnection(db, await a.authorize({ ...a.slack, tenantId: b.viewer.tenantId, subject: b.viewer.subject, role: "OWNER", viewer: b.viewer }));
    assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, b.viewer.tenantId)), 0);
    await b.repo.upsertProviderConnection(db, await b.authorize(b.slack));
    await a.repo.revokeProviderConnection(db, { provider: "slack", tenantId: b.viewer.tenantId } as { provider: "slack" });
    const [other] = await db.select().from(providerConnections).where(eq(providerConnections.tenantId, b.viewer.tenantId));
    assert.equal(other.status, "ACTIVE");
    const admitted = await a.authorize(a.slack);
    for (const denied of [null, { ...a.viewer, role: "MEMBER" as const }, { ...a.viewer, tenantId: b.viewer.tenantId }, { ...a.viewer, subject: "auth0|unknown" }]) {
      await assert.rejects(a.repository(denied).upsertProviderConnection(db, admitted));
      await assert.rejects(a.repository(denied).revokeProviderConnection(db, { provider: "slack" }));
    }
  });

  for (const revoked of ["role", "membership", "tenant", "ambiguous"] as const) {
    integration(`fresh database authority rejects stale session after ${revoked} change`, async () => {
      const { viewer, repo, slack, service, stateInput, callback, authorize } = await fixture();
      const admitted = await authorize(slack);
      const state = await service.createOAuthState(stateInput);
      if (revoked === "tenant") await db.update(tenants).set({ active: false }).where(eq(tenants.id, viewer.tenantId));
      else if (revoked === "ambiguous") {
        const other = await fixture();
        await db.insert(tenantMemberships).values({ tenantId: other.viewer.tenantId, id: randomUUID(), auth0Subject: viewer.subject, role: "OWNER" });
      } else await db.update(tenantMemberships).set(revoked === "role" ? { role: "MEMBER" } : { active: false }).where(eq(tenantMemberships.tenantId, viewer.tenantId));
      await assert.rejects(repo.upsertProviderConnection(db, admitted));
      await assert.rejects(repo.revokeProviderConnection(db, { provider: "slack" }));
      await assert.rejects(service.consumeOAuthState(state, callback));
      assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, viewer.tenantId)), 0);
    });
  }

  integration("persisted ADMIN can manage connections without granting GitHub personal-token authority", async () => {
    const { viewer, repository, github, slack, authorize } = await fixture();
    await db.update(tenantMemberships).set({ role: "ADMIN" }).where(eq(tenantMemberships.tenantId, viewer.tenantId));
    const repo = repository({ ...viewer, role: "ADMIN" });
    assert.equal((await repo.upsertProviderConnection(db, await authorize(github))).status, "ACTIVE");
    const githubAdmission = await authorize(github);
    await assert.rejects(repo.upsertProviderConnection(db, { ...githubAdmission, encryptedSecret: slack.encryptedSecret } as typeof githubAdmission));
    const slackAdmission = await authorize(slack);
    await assert.rejects(repo.upsertProviderConnection(db, { ...slackAdmission, encryptedSecret: token }));
    await assert.rejects(repo.upsertProviderConnection(db, { ...slackAdmission, encryptedSecret: sealConnectionSecret(token, "cd".repeat(32)) }));
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
      await a.repo.upsertProviderConnection(db, await a.authorize(provider === "slack" ? a.slack : a.github));
      const initialStateCount = await db.$count(oauthStates, eq(oauthStates.tenantId, a.viewer.tenantId));
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
      assert.equal(await db.$count(oauthStates, eq(oauthStates.tenantId, a.viewer.tenantId)), initialStateCount + 2);
      assert.equal(await db.$count(audit, eq(audit.tenantId, a.viewer.tenantId)), beforeAudit + 1);
      assert.equal(await db.$count(inbox, eq(inbox.tenantId, a.viewer.tenantId)), 1);
      await assert.rejects(db.insert(inbox).values({ ...event, id: randomUUID() }));
      await assert.rejects(a.service.consumeOAuthState(pending, callback));
      await assert.rejects(a.service.consumeOAuthState(consumed, callback));
      assert.deepEqual(await a.repo.revokeProviderConnection(db, { provider }), revoked);
      const [afterTenant] = await db.select().from(tenants).where(eq(tenants.id, a.viewer.tenantId));
      assert.equal(afterTenant.configVersion, beforeTenant.configVersion + 2);
      await a.repo.upsertProviderConnection(db, await a.authorize(provider === "slack" ? a.slack : a.github));
      const [stillDisabled] = await db.select().from(channelMappings).where(eq(channelMappings.tenantId, a.viewer.tenantId));
      assert.equal(stillDisabled.enabled, false);
    });
  }

  integration("audit failure rolls back revocation, mappings, config version and state invalidation", async () => {
    const { viewer, repo, slack, service, stateInput, callback, authorize } = await fixture();
    await repo.upsertProviderConnection(db, await authorize(slack));
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
      const admitted = await service.consumeOAuthState(state, callback);
      assert.equal(admitted.tenantId, viewer.tenantId);
      assert.equal(admitted.completion.generation, beforeTenant.configVersion);
      assert.equal((await repo.upsertProviderConnection(db, { ...slack, completion: admitted.completion })).status, "ACTIVE");
    } finally { await db.execute(sql`alter table ${audit} drop constraint task4_force_rollback`); }
  });

  integration("composite membership keys reject orphan and cross-tenant connection/state records", async () => {
    const a = await fixture();
    const b = await fixture();
    await a.repo.upsertProviderConnection(db, await a.authorize(a.slack));
    const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.tenantId, a.viewer.tenantId));
    await assert.rejects(db.insert(providerConnections).values({ ...connection, id: randomUUID() }));
    await assert.rejects(db.insert(providerConnections).values({ ...connection, tenantId: b.viewer.tenantId }));
    await assert.rejects(db.insert(providerConnections).values({ ...connection, tenantId: randomUUID() }));
    await a.service.createOAuthState(a.stateInput);
    const [state] = await db.select().from(oauthStates).where(eq(oauthStates.tenantId, a.viewer.tenantId));
    await assert.rejects(db.insert(oauthStates).values({ ...state, tenantId: b.viewer.tenantId }));
    await assert.rejects(db.insert(oauthStates).values({ ...state, provider: "unknown" as "slack", stateHash: "a".repeat(64) }));
  });

  for (const provider of ["slack", "github"] as const) {
    integration(`${provider} consumed callback completion cannot outlive disconnect; fresh state reconnects`, async () => {
      const { viewer, repo, service, stateInput, callback, slack, github, authorize } = await fixture();
      const providerInput = provider === "slack" ? slack : github;
      await repo.upsertProviderConnection(db, await authorize(providerInput));
      await db.update(channelMappings).set({ enabled: true }).where(eq(channelMappings.tenantId, viewer.tenantId));
      const state = await service.createOAuthState({ ...stateInput, provider });
      const admitted = await service.consumeOAuthState(state, { ...callback, provider });
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => { resume = resolve; });
      const completion = paused.then(() => repo.upsertProviderConnection(db, { ...providerInput, completion: admitted.completion }));
      // Install the rejection handler before releasing the paused callback.
      const rejected = assert.rejects(completion, /^Error: Provider connection is unavailable\.$/);
      await repo.revokeProviderConnection(db, { provider });
      const auditCount = await db.$count(audit, eq(audit.tenantId, viewer.tenantId));
      const [currentTenant] = await db.select().from(tenants).where(eq(tenants.id, viewer.tenantId));
      // Knowing the new generation cannot upgrade the old persisted envelope.
      await assert.rejects(repo.upsertProviderConnection(db, { ...providerInput, completion: { ...admitted.completion, generation: currentTenant.configVersion } }));
      resume();
      await rejected;
      const [revoked] = await db.select().from(providerConnections).where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, provider)));
      const [mapping] = await db.select().from(channelMappings).where(eq(channelMappings.tenantId, viewer.tenantId));
      assert.equal(revoked.status, "REVOKED");
      assert.equal(revoked.encryptedSecret, null);
      assert.ok(revoked.revokedAt);
      assert.equal(mapping.enabled, false);
      assert.equal(await db.$count(audit, eq(audit.tenantId, viewer.tenantId)), auditCount);

      const fresh = await service.createOAuthState({ ...stateInput, provider });
      const freshAdmission = await service.consumeOAuthState(fresh, { ...callback, provider });
      assert.ok(freshAdmission.completion.generation > admitted.completion.generation);
      assert.equal((await repo.upsertProviderConnection(db, { ...providerInput, completion: freshAdmission.completion })).status, "ACTIVE");
      const [connected] = await db.select().from(providerConnections).where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, provider)));
      assert.equal(connected.revokedAt, null);
      if (provider === "slack") assert.equal(openConnectionSecret(connected.encryptedSecret!, key), token);
      else assert.equal(connected.encryptedSecret, null);
      assert.equal(await db.$count(audit, eq(audit.tenantId, viewer.tenantId)), auditCount + 1);
      await assert.rejects(repo.upsertProviderConnection(db, { ...providerInput, completion: admitted.completion }));

      // Even an already-REVOKED connection must cancel callbacks that were
      // admitted since its previous disconnect, with no new ACTIVE audit row.
      await repo.revokeProviderConnection(db, { provider });
      const betweenDisconnects = await authorize(providerInput);
      const beforeRepeated = await db.$count(audit, eq(audit.tenantId, viewer.tenantId));
      await repo.revokeProviderConnection(db, { provider });
      await assert.rejects(repo.upsertProviderConnection(db, betweenDisconnects));
      const [stillRevoked] = await db.select().from(providerConnections).where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, provider)));
      assert.equal(stillRevoked.status, "REVOKED");
      assert.equal(stillRevoked.encryptedSecret, null);
      assert.equal(await db.$count(audit, eq(audit.tenantId, viewer.tenantId)), beforeRepeated);
      const newest = await authorize(providerInput);
      assert.ok(newest.completion.generation > betweenDisconnects.completion.generation);
      assert.equal((await repo.upsertProviderConnection(db, newest)).status, "ACTIVE");
    });
  }

  integration("completion requires its original tenant, subject, provider and unexpired consumed state", async () => {
    const a = await fixture();
    const b = await fixture();
    const admitted = await a.authorize(a.slack);
    const other = await b.authorize(b.slack);
    for (const completion of [
      undefined, { ...admitted.completion, tenantId: b.viewer.tenantId }, { ...admitted.completion, subject: b.viewer.subject },
      { ...admitted.completion, provider: "github" }, { ...other.completion, tenantId: a.viewer.tenantId, subject: a.viewer.subject },
    ]) await assert.rejects(a.repo.upsertProviderConnection(db, { ...admitted, completion } as typeof admitted));
    const adminSubject = `auth0|${randomUUID()}`;
    await db.insert(tenantMemberships).values({ tenantId: a.viewer.tenantId, id: randomUUID(), auth0Subject: adminSubject, role: "ADMIN" });
    const otherAdmin = a.repository({ ...a.viewer, subject: adminSubject, role: "ADMIN" });
    await assert.rejects(otherAdmin.upsertProviderConnection(db, admitted));
    await assert.rejects(otherAdmin.upsertProviderConnection(db, { ...admitted, completion: { ...admitted.completion, subject: adminSubject } }));
    assert.equal(await db.$count(providerConnections, eq(providerConnections.tenantId, a.viewer.tenantId)), 0);
    assert.equal(await db.$count(audit, eq(audit.tenantId, a.viewer.tenantId)), 0);
    assert.equal((await a.repo.upsertProviderConnection(db, admitted)).status, "ACTIVE");
    const expiring = await a.authorize(a.slack);
    const [record] = await db.select().from(oauthStates).where(and(eq(oauthStates.tenantId, a.viewer.tenantId), eq(oauthStates.stateHash, expiring.completion.stateHash)));
    const expiresAt = new Date(Date.now() - 60_000);
    const expiredPayload = { ...JSON.parse(openConnectionSecret(record.encryptedPayload, key)), expiresAt: expiresAt.toISOString() };
    // Keep the envelope and DB metadata consistent, so this specifically
    // exercises the database-clock expiry gate rather than tamper rejection.
    await db.update(oauthStates).set({ createdAt: new Date(Date.now() - 120_000), expiresAt, encryptedPayload: sealConnectionSecret(JSON.stringify(expiredPayload), key) })
      .where(and(eq(oauthStates.tenantId, a.viewer.tenantId), eq(oauthStates.stateHash, expiring.completion.stateHash)));
    await assert.rejects(a.repo.upsertProviderConnection(db, expiring));
    assert.equal(await db.$count(audit, eq(audit.tenantId, a.viewer.tenantId)), 1);
  });
}
