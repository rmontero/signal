import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import test, { after, afterEach, beforeEach, mock } from "node:test";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import type { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { schema } from "../../src/db/schema.ts";
import type { SignalDb } from "../../src/db/client.ts";
import type { Membership } from "../../src/lib/tenant-context.ts";

// Keep the production Auth0 resolver, SQL predicates and revoke transaction.
// Replace only the session/DB transports; no provider or real database calls.
const fixtureGlobal = globalThis as typeof globalThis & {
  __task7Db: () => { db: SignalDb; pool: { end(): Promise<void> } };
};
type Resolve = (specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => ResolveFnOutput) => ResolveFnOutput;
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (/\/db\/client(?:\.ts)?$/.test(specifier)) return { url: "data:text/javascript,export function createDb(){return globalThis.__task7Db();}", shortCircuit: true };
  return nextResolve(specifier, context);
} });
after(() => hooks.deregister());
const { default: SettingsPage } = await import("../../src/app/settings/page.tsx");
const { GET } = await import("../../src/app/api/settings/connections/route.ts");
const { POST } = await import("../../src/app/api/settings/connections/[provider]/revoke/route.ts");
const { listTenantConnections } = await import("../../src/app/api/settings/connections/[provider]/revoke/handler.ts");
const { SettingsConnections, parseConnectionSnapshot } = await import("../../src/components/settings-connections.tsx");

const member: Membership = { subject: "auth0|synthetic-owner", tenantId: "synthetic-tenant-a", role: "OWNER", active: true, tenantActive: true };
const stamp = "2026-09-13T12:00:00.000Z";
const secret = "xoxb-synthetic-private-token";
const environment = {
  AUTH0_SECRET: "c".repeat(64), AUTH0_BASE_URL: "https://signal.example",
  AUTH0_ISSUER_BASE_URL: "https://task7.example.auth0.com", AUTH0_CLIENT_ID: "fixture", AUTH0_CLIENT_SECRET: "fixture",
  CONNECTIONS_ENCRYPTION_KEY: "ab".repeat(32),
  GITHUB_APP_INSTALLATION_URL: "https://github.com/apps/signal-test/installations/new", GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "SYNTHETIC BEGIN KEY",
  SLACK_OAUTH_AUTHORIZE_URL: "https://slack.com/oauth/v2/authorize", SLACK_CLIENT_ID: "123.456", SLACK_APP_ID: "ATEST123",
};
const previous = { ...process.env };
let memberships: Membership[];
let records: Record<string, unknown>[];
let queries: { text: string; values: unknown[] }[];
let failure: string | undefined;
let lockedMember: Membership | undefined;
let authenticated: boolean;
let opened: number;
let closed: number;
let closeFails: boolean;
let providerCalls: number;
const connection = (provider = "github") => ({
  tenant_id: member.tenantId, id: `private-connection-${provider}`, provider,
  external_account_id: provider === "github" ? "123456789" : "T123456789", installation_id: provider === "github" ? "private-installation-id" : null,
  bot_user_id: provider === "slack" ? "U_PRIVATE_BOT" : null, display_name: provider === "github" ? "Synthetic team" : "Synthetic workspace",
  encrypted_secret: secret, scopes: provider === "github" ? ["issues:write", "metadata:read"] : ["chat:write", "channels:read"],
  status: "ACTIVE", connected_by_subject: member.subject, created_at: stamp, updated_at: stamp, revoked_at: null,
});
function project(text: string, rows: Record<string, unknown>[]) {
  const projection = text.startsWith("select ") ? text.slice(7, text.indexOf(" from ")) : text.split(" returning ")[1];
  const columns = projection.split(", ").map((field) => [...field.matchAll(/"([a-z_]+)"/g)].at(-1)![1]);
  return rows.map((row) => columns.map((column) => row[column]));
}
const db = drizzle({ async query(query: { text: string }, values: unknown[] = []) {
  queries.push({ text: query.text, values });
  if (failure && query.text.includes(failure)) throw new Error(`${secret} PRIVATE_SQL`, { cause: member.subject });
  if (query.text.includes('from "tenant_memberships"')) {
    const locked = query.text.includes("for update");
    return { rows: (locked && lockedMember ? [lockedMember] : memberships).map((m) => [m.subject, m.tenantId, m.role, m.active, m.tenantActive, ...(locked ? [7] : [])]) };
  }
  if (query.text.includes('from "provider_connections"')) return { rows: project(query.text, records) };
  if (query.text.startsWith('update "provider_connections"')) {
    records = records.map((row) => ({ ...row, status: "REVOKED", encrypted_secret: null, revoked_at: stamp, updated_at: stamp }));
    return { rows: project(query.text, records) };
  }
  return { rows: [], rowCount: 0 };
} } as unknown as Pool, { schema });

beforeEach(() => {
  Object.assign(process.env, environment);
  memberships = [{ ...member }]; records = []; queries = []; failure = undefined; lockedMember = undefined;
  authenticated = true; opened = 0; closed = 0; closeFails = false; providerCalls = 0;
  fixtureGlobal.__task7Db = () => { opened++; return { db, pool: { end: async () => { closed++; if (closeFails) throw new Error(secret); } } }; };
  mock.method(Auth0Client.prototype, "getSession", async () => authenticated ? ({
    user: { sub: member.subject, tenantId: "attacker-tenant", role: "OWNER", email: "private@example.invalid" },
    tokenSet: { accessToken: secret, expiresAt: 1 }, internal: { sid: "fixture", createdAt: 1 },
  }) as SessionData : null);
  mock.method(globalThis, "fetch", async () => { providerCalls++; throw new Error("Provider access forbidden"); });
});
afterEach(() => {
  assert.equal(providerCalls, 0);
  assert.equal(opened, closed);
  mock.restoreAll();
  for (const key of Object.keys(environment)) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

const get = (query = "") => GET(new Request(`https://signal.example/api/settings/connections${query}`, { headers: { "x-tenant-id": "attacker-tenant", cookie: "tenantId=attacker-tenant" } }));
function revoke(provider = "github", init: RequestInit = {}, query = "") {
  return POST(new Request(`https://signal.example/api/settings/connections/${provider}/revoke${query}`, {
    method: "POST", headers: { origin: "https://signal.example", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ confirm: true }), ...init,
  }), { params: Promise.resolve({ provider }) });
}
function noPrivate(text: string) {
  assert.doesNotMatch(text, /xoxb-|PRIVATE_|private-connection|private-installation|123456789|auth0\||synthetic-tenant|attacker-tenant|private@example|encryptedSecret|encrypted_secret|connectedBySubject|botUserId|installationId/);
}
async function expectError(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(await response.json(), { status: "unavailable" });
}
function redirected(error: unknown) {
  return !!error && typeof error === "object" && "digest" in error && String(error.digest).includes(";/auth/login?returnTo=%2Fsettings;");
}

test("anonymous Settings redirects and both APIs deny without opening persistence", async () => {
  authenticated = false;
  await assert.rejects(SettingsPage({ searchParams: Promise.resolve({ tenantId: "attacker-tenant" }) }), redirected);
  await expectError(await get(), 401);
  await expectError(await revoke(), 401);
  assert.equal(opened, 0);
});

test("inactive, inactive-tenant, mismatched and ambiguous memberships cannot view or revoke", async () => {
  for (const rows of [[{ ...member, active: false }], [{ ...member, tenantActive: false }], [{ ...member, subject: "auth0|other" }], [member, { ...member, tenantId: "other-tenant" }]]) {
    memberships = rows;
    await assert.rejects(SettingsPage({ searchParams: Promise.resolve({}) }), redirected);
    await expectError(await get(), 401);
    await expectError(await revoke(), 401);
  }
  assert.ok(queries.every(({ text }) => !text.includes('"provider_connections"')));
});

test("the page serializes only a fixed callback notice, never a viewer or arbitrary query text", async () => {
  const page = await SettingsPage({ searchParams: Promise.resolve({ github: "connected", slack: secret, tenantId: "attacker-tenant", error_description: secret, next: "https://evil.invalid" }) });
  const markup = renderToStaticMarkup(page);
  noPrivate(markup);
  const client = (page.props.children as unknown[]).find((child) => isValidElement(child) && child.type === SettingsConnections);
  assert.ok(isValidElement(client));
  assert.deepEqual(client.props, { notice: "returned" });
  assert.match(markup, /Loading connections/);
  assert.doesNotMatch(markup, /GitHub connected|Slack connected/);
});

test("list binds only the freshly verified tenant and projects safe metadata before returning", async () => {
  records = [connection(), connection("slack")];
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json();
  assert.equal(payload.canManage, true);
  assert.deepEqual(payload.setup, { github: true, slack: true });
  assert.deepEqual(payload.connections[0], { provider: "github", displayName: "Synthetic team", externalIdSuffix: "6789", scopes: ["issues:write", "metadata:read"], status: "ACTIVE", createdAt: stamp, updatedAt: stamp, revokedAt: null });
  noPrivate(JSON.stringify(payload));
  const reads = queries.filter(({ text }) => text.includes('from "provider_connections"'));
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].values, [member.tenantId, 3]);
  assert.match(reads[0].text, /where "provider_connections"\."tenant_id" = \$1/);
  assert.doesNotMatch(reads[0].text, /encrypted_secret|connected_by_subject|bot_user_id|installation_id/);
});

test("direct list callers cannot substitute a tenant, subject or role", async () => {
  for (const viewer of [{ ...member, tenantId: "attacker-tenant" }, { ...member, subject: "auth0|other" }, { ...member, role: "ADMIN" as const }]) {
    await assert.rejects(listTenantConnections(viewer), /^Error: Connections are unavailable\.$/);
  }
  assert.ok(queries.every(({ text }) => !text.includes('"provider_connections"')));
});

test("cross-tenant rows, duplicate providers and malformed lifecycle data fail closed", async () => {
  for (const rows of [[{ ...connection(), tenant_id: "other-tenant" }], [connection(), connection()], [{ ...connection(), status: "UNKNOWN" }], [{ ...connection(), updated_at: "invalid" }]]) {
    records = rows;
    await expectError(await get(), 503);
  }
});

test("credential-like metadata and unsupported or short external IDs are never rendered", async () => {
  records = [{ ...connection(), display_name: secret, external_account_id: "123", scopes: ["issues:write", secret, "arbitrary:scope"] }];
  let payload = await (await get()).json();
  assert.equal(payload.connections[0].displayName, null);
  assert.equal(payload.connections[0].externalIdSuffix, null);
  assert.deepEqual(payload.connections[0].scopes, ["issues:write"]);
  records = [{ ...connection("slack"), external_account_id: secret, display_name: member.subject }];
  payload = await (await get()).json();
  assert.equal(payload.connections[0].externalIdSuffix, null);
  noPrivate(renderToStaticMarkup(createElement(SettingsConnections, { initialSnapshot: payload })));
});

test("MEMBER can read safe summaries but cannot revoke even with forged owner/tenant claims", async () => {
  memberships = [{ ...member, role: "MEMBER" }]; records = [connection()];
  const payload = await (await get()).json();
  assert.equal(payload.canManage, false);
  const markup = renderToStaticMarkup(createElement(SettingsConnections, { initialSnapshot: payload }));
  assert.match(markup, /Only workspace owners and administrators/);
  assert.doesNotMatch(markup, /href="[^"]*\/start|Disconnect GitHub/);
  await expectError(await revoke("github", { body: JSON.stringify({ confirm: true, role: "OWNER", tenantId: member.tenantId }) }), 403);
  assert.ok(queries.every(({ text }) => !/^(begin|update|insert)/.test(text)));
});

test("OWNER and ADMIN revoke through the existing mapping/state/generation fence transaction", async () => {
  for (const role of ["OWNER", "ADMIN"] as const) {
    memberships = [{ ...member, role }]; records = [connection("slack")]; queries = [];
    const response = await revoke("slack");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "revoked" });
    assert.match(queries.find(({ text }) => text.startsWith('update "channel_mappings"'))!.text, /"enabled" = \$1/);
    assert.ok(queries.some(({ text }) => text.startsWith('update "oauth_states"') && text.includes('"consumed_at" is null')));
    assert.ok(queries.some(({ text }) => text.startsWith('update "tenants"') && text.includes('"config_version" + 1')));
    assert.ok(queries.some(({ text }) => text.startsWith('insert into "audit"')));
    for (const { text, values } of queries.filter(({ text }) => text.startsWith("update "))) {
      assert.match(text, /"tenant_id"|"tenants"\."id"/);
      assert.ok(values.includes(member.tenantId));
    }
    assert.equal(queries.at(-1)?.text, "commit");
    assert.ok(!queries.some(({ text }) => text.startsWith("delete ")));
  }
});

test("revocation rechecks locked persisted membership and never weakens a changed role or tenant", async () => {
  records = [connection()];
  for (const value of [{ ...member, role: "MEMBER" as const }, { ...member, active: false }, { ...member, tenantId: "other-tenant" }]) {
    lockedMember = value; queries = [];
    await expectError(await revoke(), 503);
    assert.equal(queries.at(-1)?.text, "rollback");
    assert.ok(!queries.some(({ text }) => /^(update|insert|delete)/.test(text)));
  }
});

test("repeated revoke retains repository fencing; missing connections and failed writes stay generic", async () => {
  records = [{ ...connection(), status: "REVOKED", revoked_at: stamp, encrypted_secret: null }];
  assert.equal((await revoke()).status, 200);
  assert.ok(queries.some(({ text }) => text.startsWith('update "tenants"')));
  records = [];
  await expectError(await revoke(), 503);
  records = [connection()]; failure = 'update "tenants"';
  await expectError(await revoke(), 503);
  assert.equal(queries.at(-1)?.text, "rollback");
});

test("revocation rejects absent/foreign/null origins and same-site cross-origin CSRF", async () => {
  for (const origin of [undefined, "https://evil.example", "null", "https://sub.signal.example"]) {
    await expectError(await revoke("github", { headers: { "content-type": "application/json", ...(origin ? { origin } : {}), host: "evil.example", "x-forwarded-host": "evil.example" } }), 403);
  }
  await expectError(await revoke("github", { headers: { origin: "https://signal.example", "content-type": "application/json", "sec-fetch-site": "cross-site" } }), 403);
  assert.ok(!queries.some(({ text }) => text.startsWith("begin")));
});

test("revoke requires an exact explicit confirmation; rejects unexpected inputs and oversize bodies", async () => {
  for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, tenantId: member.tenantId }, { confirm: true, installationId: "1" }, { confirm: true, returnTo: "https://evil.invalid" }, null]) {
    await expectError(await revoke("github", { body: JSON.stringify(body) }), 400);
  }
  await expectError(await revoke("github", { body: "{" }), 400);
  await expectError(await revoke("github", { body: " ".repeat(1025) }), 400);
  await expectError(await revoke("github", { headers: { origin: "https://signal.example", "content-type": "text/plain" } }), 400);
  await expectError(await revoke("other"), 400);
  await expectError(await revoke("github", {}, "?tenantId=attacker-tenant"), 400);
  await expectError(await get("?tenantId=attacker-tenant"), 400);
  assert.ok(!queries.some(({ text }) => text.startsWith("begin")));
});

test("missing provider configuration disables setup without preventing local disconnect", async () => {
  delete process.env.GITHUB_APP_INSTALLATION_URL; delete process.env.SLACK_CLIENT_ID;
  records = [connection()];
  const payload = await (await get()).json();
  assert.deepEqual(payload.setup, { github: false, slack: false });
  const markup = renderToStaticMarkup(createElement(SettingsConnections, { initialSnapshot: payload }));
  assert.match(markup, /Connection setup is unavailable/);
  assert.doesNotMatch(markup, /href="[^"]*\/start/);
  assert.equal((await revoke()).status, 200);
});

test("session, SQL and cleanup failures expose only safe unavailable states", async () => {
  failure = 'from "provider_connections"'; closeFails = true;
  await expectError(await get(), 503);
  failure = 'from "tenant_memberships"';
  await expectError(await get(), 401);
  mock.method(Auth0Client.prototype, "getSession", async () => { throw new Error(secret); });
  await assert.rejects(SettingsPage({ searchParams: Promise.resolve({}) }), redirected);
});

test("cards distinguish persisted, revoked and disconnected states and explain trusted enrollment", async () => {
  records = [connection(), { ...connection("slack"), status: "REVOKED", revoked_at: stamp }];
  let markup = renderToStaticMarkup(createElement(SettingsConnections, { initialSnapshot: await (await get()).json(), notice: "returned" }));
  assert.match(markup, /Connection saved/); assert.match(markup, /Disconnected/);
  assert.match(markup, /Trusted GitHub installation enrollment/);
  assert.match(markup, /repository.*channel mapping/i);
  assert.match(markup, /\/api\/settings\/connections\/github\/start\?returnTo=%2Fsettings/);
  assert.match(markup, /\/api\/settings\/connections\/slack\/start\?returnTo=%2Fsettings/);
  assert.doesNotMatch(markup, /installation_id|name="tenantId"|GitHub connected|Slack connected/);
  noPrivate(markup);
  records = [];
  markup = renderToStaticMarkup(createElement(SettingsConnections, { initialSnapshot: await (await get()).json() }));
  assert.match(markup, /Not connected/);
});

test("client snapshot parsing drops extra fields and refuses malformed or duplicate records", async () => {
  records = [connection()];
  const payload = await (await get()).json();
  noPrivate(JSON.stringify(parseConnectionSnapshot({ ...payload, token: secret, connections: payload.connections.map((row: object) => ({ ...row, token: secret, subject: member.subject })) })));
  for (const value of [{}, { ...payload, canManage: "true" }, { ...payload, connections: [payload.connections[0], payload.connections[0]] }, { ...payload, connections: [{ ...payload.connections[0], displayName: secret }] }]) {
    assert.throws(() => parseConnectionSnapshot(value));
  }
});

test("missing Auth0 configuration fails closed in a fresh process", async () => {
  const { spawnSync } = await import("node:child_process");
  const source = `import { registerHooks } from 'node:module'; registerHooks({resolve(s,c,n){return s==='server-only'?{url:'data:text/javascript,export {};',shortCircuit:true}:n(s,c);}}); globalThis.fetch=async()=>{throw Error('Provider calls forbidden')}; const { GET }=await import('./src/app/api/settings/connections/route.ts'); const r=await GET(new Request('https://signal.example/api/settings/connections')); console.log(r.status,await r.text());`;
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", source], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "production" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '401 {"status":"unavailable"}');
  assert.equal(result.stderr, "");
});
