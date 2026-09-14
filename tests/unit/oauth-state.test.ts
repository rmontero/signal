import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import test, { after, mock } from "node:test";
import type { Pool } from "@neondatabase/serverless";
import { getTableColumns, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { schema, oauthStates, providerConnections } from "../../src/db/schema.ts";
import type { ViewerTenant } from "../../src/lib/tenant-context.ts";
import type { OAuthStateRecord } from "../../src/db/connection-repository.ts";
import type { OAuthStateStore } from "../../src/lib/oauth-state.ts";

type Resolve = (specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => ResolveFnOutput) => ResolveFnOutput;
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only" ? { url: "data:text/javascript,export {};", shortCircuit: true } : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { createOAuthStateService } = await import("../../src/lib/oauth-state.ts");
const { openConnectionSecret, sealConnectionSecret } = await import("../../src/lib/connection-crypto.ts");
const { createConnectionRepository } = await import("../../src/db/connection-repository.ts");
const viewer: ViewerTenant = { tenantId: "tenant-a", subject: "auth0|owner-a", role: "OWNER" };
const key = "ab".repeat(32);
const input = { tenantId: viewer.tenantId, subject: viewer.subject, provider: "slack" as const, returnTo: "/settings?connected=slack#connections" };
const callback = { subject: viewer.subject, provider: "slack" as const };

function fixture() {
  let now = new Date("2026-09-13T00:00:00Z");
  let authority: ViewerTenant | null = viewer;
  let encryptionKey = key;
  const rows = new Map<string, OAuthStateRecord>();
  const store: OAuthStateStore = {
    async save(row) { rows.set(row.stateHash, { ...row, consumedAt: null }); },
    async read(query) {
      const row = rows.get(query.stateHash);
      return row && row.tenantId === query.tenantId && row.subject === query.subject && row.provider === query.provider && !row.consumedAt ? { ...row } : null;
    },
    async consume(query) {
      // Fake only the persistence boundary. Real SQL atomicity/concurrency is
      // covered separately in connection-repository integration tests.
      const row = rows.get(query.stateHash);
      if (!row || row.tenantId !== query.tenantId || row.subject !== query.subject || row.provider !== query.provider || row.consumedAt) return null;
      const original = { ...row };
      row.consumedAt = now;
      return original;
    },
  };
  const service = createOAuthStateService({ store, resolveViewerTenant: async () => authority, getEncryptionKey: () => encryptionKey, now: () => now });
  return { service, store, rows, setNow(value: string) { now = new Date(value); }, setViewer(value: ViewerTenant | null) { authority = value; }, setKey(value: string) { encryptionKey = value; } };
}

test("OAuth state is opaque, stored by hash, and keeps PKCE and nonce encrypted", async () => {
  const { service, rows } = fixture();
  const state = await service.createOAuthState(input);
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const hash = createHash("sha256").update(state).digest("hex");
  const stored = rows.get(hash)!;
  assert.equal(stored.tenantId, viewer.tenantId);
  assert.equal(stored.subject, viewer.subject);
  assert.equal(JSON.stringify(stored).includes(state), false);
  const authorization = await service.getOAuthStateAuthorization(state, callback);
  const result = await service.consumeOAuthState(state, callback);
  assert.equal(result.tenantId, viewer.tenantId);
  assert.equal(result.returnTo, input.returnTo);
  assert.match(result.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.pkceVerifier!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorization.codeChallenge, createHash("sha256").update(result.pkceVerifier!).digest("base64url"));
  assert.equal(authorization.codeChallengeMethod, "S256");
  assert.equal(authorization.nonce, result.nonce);
  assert.equal(JSON.stringify(stored).includes(result.pkceVerifier!), false);
  assert.equal(JSON.stringify(stored).includes(result.nonce), false);
  assert.ok(rows.get(hash)?.consumedAt);
});

test("GitHub state uses a nonce without inventing personal-token OAuth authority", async () => {
  const { service } = fixture();
  const state = await service.createOAuthState({ ...input, provider: "github" });
  const query = { ...callback, provider: "github" as const };
  const authorization = await service.getOAuthStateAuthorization(state, query);
  assert.equal(authorization.codeChallenge, null);
  assert.equal(authorization.codeChallengeMethod, null);
  const consumed = await service.consumeOAuthState(state, query);
  assert.equal(consumed.pkceVerifier, null);
  assert.equal(consumed.nonce, authorization.nonce);
});

test("each OAuth attempt has independent state, nonce and verifier", async () => {
  const { service } = fixture();
  const first = await service.createOAuthState(input);
  const second = await service.createOAuthState(input);
  assert.notEqual(first, second);
  const a = await service.consumeOAuthState(first, callback);
  const b = await service.consumeOAuthState(second, callback);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.pkceVerifier, b.pkceVerifier);
});

test("state can be consumed only once, including overlapping callbacks", async () => {
  const { service } = fixture();
  const state = await service.createOAuthState(input);
  const results = await Promise.allSettled([service.consumeOAuthState(state, callback), service.consumeOAuthState(state, callback)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(service.consumeOAuthState(state, callback));
  await assert.rejects(service.getOAuthStateAuthorization(state, callback));
});

for (const expired of ["2026-09-13T00:10:00Z", "2026-09-13T00:11:00Z"]) {
  test(`expired state is rejected at ${expired}`, async () => {
    const { service, setNow } = fixture();
    const state = await service.createOAuthState(input);
    setNow(expired);
    await assert.rejects(service.getOAuthStateAuthorization(state, callback));
    await assert.rejects(service.consumeOAuthState(state, callback));
  });
}

test("anonymous, non-admin, changed-tenant and changed-subject authority cannot create or consume state", async () => {
  for (const denied of [null, { ...viewer, role: "MEMBER" as const }, { ...viewer, tenantId: "tenant-b" }, { ...viewer, subject: "auth0|other" }]) {
    const { service, setViewer, rows } = fixture();
    const state = await service.createOAuthState(input);
    setViewer(denied);
    await assert.rejects(service.createOAuthState(input));
    await assert.rejects(service.consumeOAuthState(state, callback));
    assert.equal(rows.size, 1);
    setViewer(viewer);
    assert.equal((await service.consumeOAuthState(state, callback)).tenantId, viewer.tenantId);
  }
});

test("callback subject/provider mismatch or an unknown token cannot authorize a connection", async () => {
  const { service } = fixture();
  const state = await service.createOAuthState(input);
  await assert.rejects(service.consumeOAuthState(state, { ...callback, subject: "auth0|other" }));
  await assert.rejects(service.consumeOAuthState(state, { ...callback, provider: "github" }));
  for (const invalid of ["", "a".repeat(43), `${state}=`, ` ${state}`, state.slice(1)]) await assert.rejects(service.consumeOAuthState(invalid, callback));
  assert.equal((await service.consumeOAuthState(state, callback)).tenantId, viewer.tenantId);
});

test("returnTo permits only canonical local paths and rejects encoded redirect escapes", async () => {
  for (const returnTo of ["https://attacker.example", "//attacker.example", "/\\attacker.example", "/%2fattacker.example", "/%255cattacker.example", "/%252f%252fattacker.example", "/a/..//attacker.example", "/settings%0d%0aLocation:evil", "/settings\n", "settings", "/%zz", " /settings", "/".repeat(2049)]) {
    const { service, rows } = fixture();
    await assert.rejects(service.createOAuthState({ ...input, returnTo }));
    assert.equal(rows.size, 0);
  }
  for (const returnTo of ["/", "/settings", "/settings?tab=slack#connected"]) {
    const { service } = fixture();
    const state = await service.createOAuthState({ ...input, returnTo });
    assert.equal((await service.consumeOAuthState(state, callback)).returnTo, returnTo);
  }
});

test("tampered metadata or swapped encrypted payloads cannot redirect or cross tenant boundaries", async () => {
  for (const change of ["returnTo", "expiresAt", "encryptedPayload"] as const) {
    const { service, rows } = fixture();
    const state = await service.createOAuthState(input);
    const row = [...rows.values()][0];
    if (change === "returnTo") row.returnTo = "/other";
    else if (change === "expiresAt") row.expiresAt = new Date("2027-01-01T00:00:00Z");
    else {
      await service.createOAuthState(input);
      row.encryptedPayload = [...rows.values()][1].encryptedPayload;
    }
    await assert.rejects(service.consumeOAuthState(state, callback));
    await assert.rejects(service.consumeOAuthState(state, callback));
  }
});

test("wrong encryption key and malformed PKCE payload fail closed after state consumption", async () => {
  for (const mode of ["key", "malformed", "verifier", "nonce"] as const) {
    const { service, rows, setKey } = fixture();
    const state = await service.createOAuthState(input);
    const row = [...rows.values()][0];
    if (mode === "key") setKey("cd".repeat(32));
    else if (mode === "malformed") row.encryptedPayload = "private-malformed-envelope";
    else {
      const payload = JSON.parse(openConnectionSecret(row.encryptedPayload, key));
      payload[mode === "verifier" ? "pkceVerifier" : "nonce"] = "short";
      row.encryptedPayload = sealConnectionSecret(JSON.stringify(payload), key);
    }
    await assert.rejects(service.consumeOAuthState(state, callback));
    setKey(key);
    await assert.rejects(service.consumeOAuthState(state, callback));
  }
});

test("state storage and session failures reveal no identity, key, token, payload or upstream error", async () => {
  const output: unknown[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) mock.method(console, method, (...args: unknown[]) => { output.push(args); });
  try {
    const { service, store } = fixture();
    const state = await service.createOAuthState(input);
    const privateMessage = `private-db-error ${key} ${viewer.subject} ${state}`;
    store.consume = async () => { throw new Error(privateMessage); };
    await assert.rejects(service.consumeOAuthState(state, callback), (error: unknown) => {
      assert.ok(error instanceof Error);
      const visible = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
      for (const hidden of [key, state, viewer.subject, "private-db-error"]) assert.equal(visible.includes(hidden), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    store.save = async () => { throw new Error(privateMessage); };
    await assert.rejects(service.createOAuthState(input), /^Error: OAuth state is unavailable\.$/);
    assert.deepEqual(output, []);
  } finally { mock.restoreAll(); }
});

// Exercise production Drizzle SQL generation and repository admission without
// pretending this driver double proves PostgreSQL execution or isolation.
function sqlFixture(authority: ViewerTenant | null = viewer) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let members: unknown[][] = [[viewer.subject, viewer.tenantId, "OWNER", true, true]];
  let failSql = "";
  const connection: typeof providerConnections.$inferSelect = {
    tenantId: viewer.tenantId, id: "connection-1", provider: "slack", externalAccountId: "team-1", installationId: null,
    botUserId: "bot-1", displayName: "Fixture", encryptedSecret: sealConnectionSecret("private-token-marker", key),
    scopes: ["chat:write"], status: "ACTIVE", connectedBySubject: viewer.subject,
    createdAt: new Date("2026-09-13T00:00:00Z"), updatedAt: new Date("2026-09-13T00:00:00Z"), revokedAt: null,
  };
  const state: OAuthStateRecord = {
    tenantId: viewer.tenantId, subject: viewer.subject, provider: "slack", stateHash: "a".repeat(64),
    returnTo: "/settings", encryptedPayload: sealConnectionSecret("fixture-payload", key),
    createdAt: new Date(), expiresAt: new Date(Date.now() + 600_000), consumedAt: null,
  };
  function wireRow(table: Table, row: Record<string, unknown>) {
    return Object.keys(getTableColumns(table)).map((column) => row[column] instanceof Date ? row[column].toISOString() : row[column]);
  }
  const db = drizzle({
    async query(query: { text: string }, values: unknown[] = []) {
      statements.push({ text: query.text, values });
      if (failSql && query.text.includes(failSql)) throw new Error(`PRIVATE_SQL ${key} private-token-marker`, { cause: "private-payload" });
      if (query.text.includes('from "tenant_memberships"')) return { rows: members };
      if (query.text.includes('"provider_connections"') && /^(select|insert|update)/.test(query.text)) return { rows: [wireRow(providerConnections, connection)] };
      if (query.text.startsWith('update "oauth_states"') && query.text.includes("returning")) return { rows: [wireRow(oauthStates, state)] };
      return { rows: [] };
    },
  } as unknown as Pool, { schema });
  const repo = createConnectionRepository({ resolveViewerTenant: async () => authority, getEncryptionKey: () => key });
  const slack = { provider: "slack" as const, externalAccountId: "team-1", botUserId: "bot-1", displayName: "Fixture", scopes: ["chat:write"], encryptedSecret: connection.encryptedSecret! };
  const query = { tenantId: viewer.tenantId, subject: viewer.subject, provider: "slack" as const, stateHash: state.stateHash };
  return { db, repo, statements, connection, state, slack, query, setMembers(value: unknown[][]) { members = value; }, failOn(value: string) { failSql = value; } };
}

test("connection repository rejects untrusted and stale authority before any mutation", async () => {
  for (const authority of [null, { ...viewer, role: "MEMBER" as const }, { ...viewer, tenantId: "tenant-b" }, { ...viewer, subject: "auth0|other" }]) {
    const { db, repo, slack, statements } = sqlFixture(authority);
    await assert.rejects(repo.upsertProviderConnection(db, slack));
    await assert.rejects(repo.revokeProviderConnection(db, { provider: "slack" }));
    assert.equal(statements.some((query) => /^(insert|update)/.test(query.text)), false);
  }
  for (const rows of [[], [[viewer.subject, viewer.tenantId, "MEMBER", true, true]], [[viewer.subject, viewer.tenantId, "OWNER", false, true]],
    [[viewer.subject, viewer.tenantId, "OWNER", true, false]], [[viewer.subject, "tenant-b", "OWNER", true, true]],
    [[viewer.subject, viewer.tenantId, "OWNER", true, true], [viewer.subject, "tenant-b", "OWNER", true, true]]]) {
    const { db, repo, slack, statements, setMembers, query } = sqlFixture();
    setMembers(rows);
    await assert.rejects(repo.upsertProviderConnection(db, slack));
    await assert.rejects(repo.takeOAuthState(db, query));
    assert.equal(statements.some((query) => /^(insert|update)/.test(query.text)), false);
    assert.equal(statements.at(-1)?.text, "rollback");
  }
});

test("upsert uses persisted tenant authority and omits credentials from its result", async () => {
  const { db, repo, slack, statements } = sqlFixture();
  const result = await repo.upsertProviderConnection(db, { ...slack, tenantId: "browser-tenant", role: "OWNER", subject: "browser-subject" } as typeof slack);
  assert.equal(result.connectionId, "connection-1");
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.externalAccountId, "team-1");
  for (const hidden of [slack.encryptedSecret, key, "private-token-marker", "encryptedSecret", viewer.subject]) assert.equal(JSON.stringify(result).includes(hidden), false);
  const insert = statements.find((query) => query.text.startsWith('insert into "provider_connections"'))!;
  assert.ok(insert.values.includes(viewer.tenantId));
  assert.equal(insert.values.includes("browser-tenant"), false);
  assert.equal(insert.values.includes("browser-subject"), false);
  assert.match(insert.text, /on conflict \("tenant_id","provider"\)/);
  assert.match(statements.find((query) => query.text.includes('from "tenant_memberships"'))!.text, /for update/);
  assert.equal(statements.at(-1)?.text, "commit");
});

test("repo refuses plaintext/wrong-key Slack credentials and any personal GitHub secret", async () => {
  const { db, repo, slack, statements } = sqlFixture();
  for (const encryptedSecret of ["private-token-marker", sealConnectionSecret("private-token-marker", "cd".repeat(32)), sealConnectionSecret("", key)]) {
    await assert.rejects(repo.upsertProviderConnection(db, { ...slack, encryptedSecret }));
  }
  await assert.rejects(repo.upsertProviderConnection(db, { ...slack, provider: "github", installationId: "installation-1" } as never));
  assert.equal(statements.some((query) => /^(insert|update)/.test(query.text)), false);
});

test("consume emits a tenant/subject/provider-bound conditional UPDATE with database expiry and replay predicates", async () => {
  const { db, repo, query, statements } = sqlFixture();
  assert.equal((await repo.takeOAuthState(db, query))?.tenantId, viewer.tenantId);
  const update = statements.find((statement) => statement.text.startsWith('update "oauth_states"'))!;
  assert.deepEqual(update.values, [viewer.tenantId, "a".repeat(64), viewer.subject, "slack"]);
  assert.match(update.text, /"tenant_id" = \$1/);
  assert.match(update.text, /"state_hash" = \$2/);
  assert.match(update.text, /"auth0_subject" = \$3/);
  assert.match(update.text, /"provider" = \$4/);
  assert.match(update.text, /"consumed_at" is null/);
  assert.match(update.text, /"expires_at" > clock_timestamp\(\)/);
  assert.match(update.text, /returning/);
  assert.equal(statements.at(-1)?.text, "commit");
});

test("revocation marks credentials revoked, disables tenant mappings and retains replay/audit rows in one transaction", async () => {
  const { db, repo, statements } = sqlFixture();
  await repo.revokeProviderConnection(db, { provider: "slack" });
  const mappings = statements.find((query) => query.text.startsWith('update "channel_mappings"'))!;
  assert.deepEqual(mappings.values, [false, viewer.tenantId, true]);
  const revoked = statements.find((query) => query.text.startsWith('update "provider_connections"'))!;
  assert.ok(revoked.values.includes("REVOKED"));
  assert.ok(revoked.values.includes(null));
  assert.ok(revoked.values.includes(viewer.tenantId));
  assert.ok(statements.some((query) => query.text.startsWith('update "tenants"') && query.text.includes('"config_version" + 1')));
  assert.ok(statements.some((query) => query.text.startsWith('update "oauth_states"') && query.values.includes(viewer.tenantId)));
  assert.ok(statements.some((query) => query.text.startsWith('insert into "audit"')));
  assert.equal(statements.some((query) => /^delete/.test(query.text)), false);
  assert.equal(statements.at(-1)?.text, "commit");
});

test("failed connection transactions roll back and redact SQL, encrypted secrets and driver causes", async () => {
  const { db, repo, statements, failOn } = sqlFixture();
  failOn('insert into "audit"');
  await assert.rejects(repo.revokeProviderConnection(db, { provider: "slack" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
    for (const hidden of [key, "PRIVATE_SQL", "private-token-marker", "private-payload"]) assert.equal(text.includes(hidden), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(statements.at(-1)?.text, "rollback");
});
