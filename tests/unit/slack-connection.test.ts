import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import test, { after, afterEach, beforeEach, mock } from "node:test";
import type { ViewerTenant } from "../../src/lib/tenant-context.ts";
import type { OAuthStateRecord } from "../../src/db/connection-repository.ts";
import type { OAuthStateStore } from "../../src/lib/oauth-state.ts";
import type { SlackConnectionDependencies, SlackWorkspaceBinding } from "../../src/services/slack-connection.ts";
import type { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { schema } from "../../src/db/schema.ts";

type Resolve = (specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => ResolveFnOutput) => ResolveFnOutput;
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === "server-only" ? { url: "data:text/javascript,export {};", shortCircuit: true } : nextResolve(specifier, context);
} });
after(() => hooks.deregister());
beforeEach(() => { mock.method(globalThis, "fetch", async () => { throw new Error("Live provider calls forbidden"); }); });
afterEach(() => mock.restoreAll());

const { createSlackConnectionService, readSlackConnectionSettings, loadSlackWorkspaceBinding } = await import("../../src/services/slack-connection.ts");
const { exchangeSlackOAuthCode, SLACK_CONNECTION_SCOPES } = await import("../../src/adapters/slack-api.ts");
const { createOAuthStateService } = await import("../../src/lib/oauth-state.ts");
const { openConnectionSecret, sealConnectionSecret } = await import("../../src/lib/connection-crypto.ts");
const viewer: ViewerTenant = { tenantId: "tenant-a", subject: "auth0|owner-a", role: "OWNER" };
const key = "ab".repeat(32);
const token = "xoxb-synthetic-private-bot-token";
const marker = "synthetic-private-provider-response";
const code = "synthetic-authorization-code";
const settings = { appBaseUrl: "https://signal.example", authorizationUrl: "https://slack.com/oauth/v2/authorize", clientId: "123.456", appId: "A123" };
const requiredScopes = ["app_mentions:read", "channels:history", "channels:read", "chat:write", "groups:history", "groups:read"];
const grant = () => ({
  ok: true, access_token: token, token_type: "bot", app_id: settings.appId, bot_user_id: "U123",
  scope: requiredScopes.join(","), team: { id: "T123", name: "Synthetic workspace" },
  authed_user: { id: "U456" }, enterprise: null, is_enterprise_install: false, private_metadata: marker,
});
const identity = () => ({ ok: true, team_id: "T123", user_id: "U123", bot_id: "B123", private_metadata: marker });
type ProviderChange = { grant?: unknown; identity?: unknown; fetch?: typeof fetch };
function providerFixture(change: ProviderChange = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.credentials, "omit");
    if (change.fetch) return change.fetch(input, init);
    if (url === "https://slack.com/api/oauth.v2.access") return Response.json("grant" in change ? change.grant : grant());
    assert.equal(url, "https://slack.com/api/auth.test");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    return Response.json("identity" in change ? change.identity : identity());
  };
  return { calls, fetchImpl };
}

function fixture(change: ProviderChange = {}, overrides: Partial<SlackConnectionDependencies> = {}) {
  let current: ViewerTenant | null = viewer;
  let clock = new Date();
  let generation = 7;
  let binding: SlackWorkspaceBinding | null = null;
  let beforeSave = () => {};
  const rows = new Map<string, OAuthStateRecord>();
  const matches = (row: OAuthStateRecord | undefined, query: Parameters<OAuthStateStore["consume"]>[0]) => row
    && row.tenantId === query.tenantId && row.subject === query.subject && row.provider === query.provider && !row.consumedAt;
  const store: OAuthStateStore = {
    async save(row, seal) { rows.set(row.stateHash, { ...row, encryptedPayload: seal(generation), consumedAt: null }); },
    async read(query) { const row = rows.get(query.stateHash); return matches(row, query) ? { ...row! } : null; },
    async consume(query) {
      const row = rows.get(query.stateHash);
      if (!matches(row, query)) return null;
      row!.consumedAt = clock;
      return { ...row! };
    },
  };
  const oauth = createOAuthStateService({ store, resolveViewerTenant: async () => current, getEncryptionKey: () => key, now: () => clock });
  const provider = providerFixture(change);
  const persisted: Parameters<SlackConnectionDependencies["saveConnection"]>[0][] = [];
  let consumed: Awaited<ReturnType<typeof oauth.consumeOAuthState>> | undefined;
  let revocations = 0;
  const dependencies: SlackConnectionDependencies = {
    resolveViewerTenant: async () => current,
    getSettings: () => settings,
    getEncryptionKey: () => key,
    loadBinding: async (authority) => { assert.deepEqual(authority, current); return binding; },
    createOAuthState: oauth.createOAuthState,
    getOAuthStateAuthorization: oauth.getOAuthStateAuthorization,
    consumeOAuthState: async (...args) => { consumed = await oauth.consumeOAuthState(...args); return consumed; },
    exchangeCode: (config, input) => exchangeSlackOAuthCode({ ...config, fetchImpl: provider.fetchImpl }, input),
    async saveConnection(input) {
      beforeSave();
      assert.equal(input.completion, consumed?.completion, "Forward the consumed completion object unchanged");
      if (input.completion.generation !== generation) throw new Error(marker);
      persisted.push(input);
      generation++;
      return { connectionId: "connection-a", externalAccountId: input.externalAccountId, botUserId: input.botUserId };
    },
    async revokeConnection() {
      revocations++;
      generation++;
      return { connectionId: "connection-a", status: "REVOKED", encryptedSecret: marker };
    },
    ...overrides,
  };
  const service = createSlackConnectionService(dependencies);
  async function start(returnTo = "/settings") {
    const response = await service.beginSlackOAuth(current, returnTo);
    return new URL(response.headers.get("location")!).searchParams.get("state")!;
  }
  return { service, dependencies, start, rows, oauth, persisted, provider,
    setViewer(value: ViewerTenant | null) { current = value; }, setBinding(value: SlackWorkspaceBinding | null) { binding = value; },
    expire() { clock = new Date(clock.getTime() + 600_000); },
    disconnectDuringCompletion() { beforeSave = () => { generation++; }; },
    get revocations() { return revocations; },
  };
}

const request = (route: string, params: Record<string, string> = {}) => new Request(`https://signal.example/api/settings/connections/slack/${route}?${new URLSearchParams(params)}`);
async function safeResponse(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const output = `${JSON.stringify([...response.headers])} ${await response.text()}`;
  for (const secret of [token, marker, key, code, "encryptedSecret", "pkceVerifier", "code_verifier", "stateHash", "generation"]) assert.equal(output.includes(secret), false);
  return output;
}
function safeError(error: unknown) {
  assert.ok(error instanceof Error);
  assert.equal(error.cause, undefined);
  for (const secret of [token, marker, key, code]) assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(secret), false);
  return true;
}

test("Slack start, callback and disconnect deny anonymous/non-admin authority before state or transport", async () => {
  for (const authority of [null, { ...viewer, role: "MEMBER" as const }]) {
    const f = fixture(); f.setViewer(authority);
    for (const route of ["start", "callback"] as const) await safeResponse(await f.service.handleRoute(request(route), route), authority ? 403 : 401);
    await assert.rejects(f.service.revokeSlackConnection(), safeError);
    assert.equal(f.rows.size, 0); assert.equal(f.provider.calls.length, 0); assert.equal(f.revocations, 0);
  }
});

test("Slack start re-resolves Auth0 authority and rejects caller-supplied tenant/subject/role", async () => {
  for (const claimed of [null, { ...viewer, tenantId: "tenant-b" }, { ...viewer, subject: "auth0|other" }, { ...viewer, role: "ADMIN" as const }]) {
    const f = fixture(); await assert.rejects(f.service.beginSlackOAuth(claimed, "/settings"), safeError);
    assert.equal(f.rows.size, 0);
  }
});

test("Slack start creates encrypted PKCE state and requests only the minimum bot scopes", async () => {
  const f = fixture(); f.setViewer({ ...viewer, role: "ADMIN" });
  const response = await f.service.handleRoute(request("start", { returnTo: "/settings?tab=connections#slack" }), "start");
  const url = new URL(response.headers.get("location")!);
  assert.equal(url.origin + url.pathname, settings.authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), settings.clientId);
  assert.deepEqual(url.searchParams.get("scope")!.split(","), requiredScopes);
  assert.equal(url.searchParams.get("redirect_uri"), `${settings.appBaseUrl}/api/settings/connections/slack/callback`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "scope", "state"]);
  const row = [...f.rows.values()][0];
  const payload = JSON.parse(openConnectionSecret(row.encryptedPayload, key));
  assert.equal(row.subject, viewer.subject); assert.equal(row.tenantId, viewer.tenantId); assert.equal(row.provider, "slack");
  assert.equal(row.stateHash, createHash("sha256").update(url.searchParams.get("state")!).digest("hex"));
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(payload.pkceVerifier).digest("base64url"));
  assert.equal(row.returnTo, "/settings?tab=connections#slack");
  assert.equal(JSON.stringify(row).includes(payload.pkceVerifier), false);
  assert.equal((await safeResponse(response, 303)).includes(payload.pkceVerifier), false);
  assert.equal(f.provider.calls.length, 0);
});

test("Slack rejects unsafe return paths and browser tenant/team/scope overrides before creating state", async () => {
  for (const returnTo of ["https://evil.example", "//evil.example", "/%2f%2fevil.example", "/%5cevil", "/settings\r\nsecret", "/a/../settings", " /settings"]) {
    const f = fixture(); await assert.rejects(f.start(returnTo), safeError); assert.equal(f.rows.size, 0);
  }
  for (const parameter of ["tenantId", "tenant_id", "team", "team_id", "scope", "client_id"]) {
    const f = fixture(); await safeResponse(await f.service.handleRoute(request("start", { [parameter]: "untrusted" }), "start"), 400);
    assert.equal(f.rows.size, 0);
  }
});

test("Slack consumes state once and persists a sealed token with the original completion fence", async () => {
  const f = fixture(); const state = await f.start();
  const result = await f.service.completeSlackOAuth({ state, code });
  assert.deepEqual(result, { connectionId: "connection-a", teamId: "T123", botUserId: "U123", scopes: requiredScopes });
  const saved = f.persisted[0];
  assert.deepEqual(Object.keys(saved).sort(), ["botUserId", "completion", "displayName", "encryptedSecret", "externalAccountId", "provider", "scopes"]);
  assert.equal(saved.displayName, "Synthetic workspace"); assert.equal(saved.externalAccountId, "T123");
  assert.equal(saved.completion.generation, 7); assert.equal(saved.completion.tenantId, viewer.tenantId);
  assert.equal(openConnectionSecret(saved.encryptedSecret, key), token);
  assert.equal(JSON.stringify({ result, saved }).includes(token), false);
  assert.equal(JSON.stringify({ result, saved }).includes(marker), false);
  const exchange = f.provider.calls[0]; const body = new URLSearchParams(String(exchange.init.body));
  const payload = JSON.parse(openConnectionSecret([...f.rows.values()][0].encryptedPayload, key));
  assert.equal(body.get("code_verifier"), payload.pkceVerifier); assert.equal(body.get("code"), code);
  assert.equal(body.get("client_id"), settings.clientId); assert.equal(body.get("client_secret"), null);
  assert.equal(body.get("redirect_uri"), `${settings.appBaseUrl}/api/settings/connections/slack/callback`);
  assert.equal(new Headers(exchange.init.headers).get("authorization"), null);
  await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError);
  assert.equal(f.provider.calls.length, 2); assert.equal(f.persisted.length, 1);
});

test("overlapping Slack callbacks make exactly one exchange and one persistence attempt", async () => {
  const f = fixture(); const state = await f.start();
  const results = await Promise.allSettled([f.service.completeSlackOAuth({ state, code }), f.service.completeSlackOAuth({ state, code })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.provider.calls.length, 2); assert.equal(f.persisted.length, 1);
});

test("Slack rejects expired state and changed tenant/subject/admin authority before exchanging code", async () => {
  for (const mode of ["expiry", "tenant", "subject", "member", "anonymous"] as const) {
    const f = fixture(); const state = await f.start();
    if (mode === "expiry") f.expire();
    else f.setViewer(mode === "anonymous" ? null : { ...viewer, ...(mode === "tenant" ? { tenantId: "tenant-b" } : mode === "subject" ? { subject: "auth0|other" } : { role: "MEMBER" as const }) });
    await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError);
    assert.equal(f.provider.calls.length, 0); assert.equal(f.persisted.length, 0);
  }
});

test("Slack rejects another provider's state, malformed PKCE and swapped encrypted state bindings", async () => {
  for (const mode of ["provider", "pkce", "tenant", "subject", "returnTo"] as const) {
    const f = fixture();
    const state = mode === "provider" ? await f.oauth.createOAuthState({ ...viewer, provider: "github", returnTo: "/settings" }) : await f.start();
    if (mode !== "provider") {
      const row = [...f.rows.values()][0]; const payload = JSON.parse(openConnectionSecret(row.encryptedPayload, key));
      if (mode === "pkce") payload.pkceVerifier = null;
      else if (mode === "tenant") payload.tenantId = "tenant-b";
      else if (mode === "subject") payload.subject = "auth0|other";
      else payload.returnTo = "//evil.example";
      row.encryptedPayload = sealConnectionSecret(JSON.stringify(payload), key);
    }
    await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError);
    assert.equal(f.provider.calls.length, 0); assert.equal(f.persisted.length, 0);
  }
});

test("Slack verifies the exact OAuth team, bot user and configured app against auth.test", async () => {
  for (const change of [
    { identity: { ...identity(), team_id: "T999" } }, { identity: { ...identity(), user_id: "U999" } },
    { identity: { ...identity(), bot_id: undefined } }, { identity: { ...identity(), bot_id: "U123" } },
    { grant: { ...grant(), app_id: "A999" } }, { grant: { ...grant(), team: { id: "t123", name: "Test" } } },
    { grant: { ...grant(), bot_user_id: "B123" } }, { grant: { ...grant(), token_type: "user" } },
  ]) {
    const f = fixture(change); const state = await f.start();
    await safeResponse(await f.service.handleRoute(request("callback", { state, code }), "callback"), 400);
    assert.equal(f.persisted.length, 0);
  }
});

test("Slack preserves existing tenant workspace/bot bindings and rejects callback team hints that disagree", async () => {
  const f = fixture(); f.setBinding({ teamId: "T123", botUserId: "U123" });
  const response = await f.service.beginSlackOAuth(viewer, "/settings");
  const url = new URL(response.headers.get("location")!); assert.equal(url.searchParams.get("team"), "T123");
  await f.service.completeSlackOAuth({ state: url.searchParams.get("state"), code, teamId: "T123" });
  for (const binding of [{ teamId: "T999" }, { teamId: "T123", botUserId: "U999" }]) {
    const denied = fixture(); denied.setBinding(binding); const state = await denied.start();
    await assert.rejects(denied.service.completeSlackOAuth({ state, code }), safeError);
    assert.equal(denied.persisted.length, 0);
  }
  const mismatch = fixture(); const state = await mismatch.start();
  await assert.rejects(mismatch.service.completeSlackOAuth({ state, code, teamId: "T999" }), safeError);
  assert.equal(mismatch.persisted.length, 0);
});

test("Slack refuses missing or excessive bot scopes and never acquires user authority", async () => {
  for (const scope of [...requiredScopes.map((missing) => requiredScopes.filter((s) => s !== missing).join(",")), `${requiredScopes},admin`, `${requiredScopes},users:read`, "", null, ["chat:write"]]) {
    const f = fixture({ grant: { ...grant(), scope } }); const state = await f.start();
    await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError); assert.equal(f.persisted.length, 0);
  }
  const f = fixture({ grant: { ...grant(), authed_user: { id: "U456", access_token: marker, scope: "chat:write", token_type: "user" } } });
  await assert.rejects(f.service.completeSlackOAuth({ state: await f.start(), code }), safeError);
  assert.equal(f.persisted.length, 0);
});

test("Slack rejects malformed, rotating and organization-wide grants and unsafe display metadata", async () => {
  for (const value of [null, [], {}, { ...grant(), ok: "true" }, { ...grant(), access_token: "xoxp-user" },
    { ...grant(), refresh_token: marker, expires_in: 43200 }, { ...grant(), is_enterprise_install: true },
    { ...grant(), is_enterprise_install: "false" }, { ...grant(), team: null },
    { ...grant(), team: { id: "T123", name: "<script>secret</script>" } },
    { ...grant(), team: { id: "T123", name: `Workspace ${token}` } },
    { ...grant(), team: { id: "T123", name: "x".repeat(121) } },
    { ...grant(), team: { id: "T123", name: "Bad\nname" } }, { ...grant(), authed_user: null }]) {
    const f = fixture({ grant: value }); const state = await f.start();
    await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError); assert.equal(f.persisted.length, 0);
  }
});

test("Slack error/cancel consumes state and redirects only to its validated return path with fixed flags", async () => {
  for (const error of ["access_denied", marker]) {
    const f = fixture(); const state = await f.start("/settings?tab=connections#slack");
    const response = await f.service.handleRoute(request("callback", { state, error, error_description: marker }), "callback");
    const url = new URL(response.headers.get("location")!);
    assert.equal(url.origin, settings.appBaseUrl); assert.equal(url.pathname, "/settings"); assert.equal(url.hash, "#slack");
    assert.equal(url.searchParams.get("slack"), error === "access_denied" ? "cancelled" : "error");
    await safeResponse(response, 303);
    await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError);
    assert.equal(f.provider.calls.length, 0); assert.equal(f.persisted.length, 0);
  }
  const f = fixture(); await safeResponse(await f.service.handleRoute(request("callback", { error: marker }), "callback"), 400);
});

test("Slack completion redirects without code, verifier, token, provider metadata or browser tenant claims", async () => {
  const f = fixture(); const state = await f.start("/settings?tab=connections#slack");
  const response = await f.service.handleRoute(request("callback", { state, code, team_id: "T123" }), "callback");
  const url = new URL(response.headers.get("location")!);
  assert.equal(url.href, `${settings.appBaseUrl}/settings?tab=connections&slack=connected&next=repository-channel-mapping#slack`);
  const output = await safeResponse(response, 303); assert.equal(output.includes(state), false);
});

test("Slack rejects ambiguous callback parameters and malformed codes without transport", async () => {
  for (const query of ["&code=one&code=two", "&code=one&tenantId=tenant-b", "&code=one&returnTo=%2Felsewhere", "&code=one&error=access_denied", "&code=", "&code=%0D%0Asecret", "&code=one&state=another"]) {
    const f = fixture(); const state = await f.start();
    await safeResponse(await f.service.handleRoute(new Request(`${settings.appBaseUrl}/api/settings/connections/slack/callback?state=${state}${query}`), "callback"), 400);
    assert.equal(f.provider.calls.length, 0); assert.equal(f.persisted.length, 0);
  }
});

test("Slack disconnect during completion cannot refresh the captured generation or resurrect a connection", async () => {
  const f = fixture(); const state = await f.start(); f.disconnectDuringCompletion();
  await safeResponse(await f.service.handleRoute(request("callback", { state, code }), "callback"), 503);
  assert.equal(f.persisted.length, 0);
  await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError); assert.equal(f.provider.calls.length, 2);
});

test("Slack disconnect delegates to Task 4 revocation and returns only fixed safe status", async () => {
  const f = fixture(); const state = await f.start();
  assert.deepEqual(await f.service.revokeSlackConnection(), { connectionId: "connection-a", status: "REVOKED" });
  assert.equal(f.revocations, 1);
  await assert.rejects(f.service.completeSlackOAuth({ state, code }), safeError); assert.equal(f.persisted.length, 0);
  const failed = fixture({}, { revokeConnection: async () => { throw new Error(`${token} ${marker}`); } });
  await assert.rejects(failed.service.revokeSlackConnection(), safeError);
});

test("Slack encryption or persistence failures expose no provider, token, state or database errors", async () => {
  const logs: unknown[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  for (const overrides of [
    { getEncryptionKey: () => "bad-key" },
    { saveConnection: async () => { throw new Error(`${token} ${marker} ${key}`); } },
    { resolveViewerTenant: async () => { throw new Error(marker); } },
  ]) {
    const f = fixture({}, overrides);
    if (overrides.resolveViewerTenant) await safeResponse(await f.service.handleRoute(request("start"), "start"), 503);
    else { const state = await f.start(); await safeResponse(await f.service.handleRoute(request("callback", { state, code }), "callback"), 503); }
    assert.equal(f.persisted.length, 0);
  }
  assert.deepEqual(logs, []);
});

test("Slack transport redacts and never retries HTTP, malformed JSON, provider or network failures", async () => {
  for (const fetchImpl of [
    async () => Response.json({ ok: false, error: marker }),
    async () => new Response(marker, { status: 429 }), async () => new Response(marker, { status: 503 }),
    async () => new Response(marker), async () => new Response("null"),
    async () => new Response(null, { status: 302, headers: { location: `https://evil.example/${marker}` } }),
    async () => { throw new Error(`${token} ${marker} ${code}`); },
    async () => new Response(new Uint8Array([0xff])),
    async () => new Response("x".repeat(1_048_577)),
  ]) {
    const f = fixture({ fetch: fetchImpl }); const state = await f.start();
    await safeResponse(await f.service.handleRoute(request("callback", { state, code }), "callback"), 400);
    assert.equal(f.provider.calls.length, 1); assert.equal(f.persisted.length, 0);
  }
});

test("Slack OAuth transport bounds stalled fetch and streaming bodies with no retry", async () => {
  const config = { clientId: settings.clientId, appId: settings.appId, redirectUri: `${settings.appBaseUrl}/api/settings/connections/slack/callback`, timeoutMs: 10 };
  const input = { code, pkceVerifier: "a".repeat(43) };
  for (const fetchImpl of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); } })),
  ]) await assert.rejects(exchangeSlackOAuthCode({ ...config, fetchImpl }, input), safeError);
});

test("Slack config restricts the authorization endpoint and uses a web callback for PKCE bot scopes", () => {
  const env = { AUTH0_SECRET: key, AUTH0_BASE_URL: settings.appBaseUrl, AUTH0_ISSUER_BASE_URL: "https://auth.example", AUTH0_CLIENT_ID: "auth0-client", AUTH0_CLIENT_SECRET: "synthetic-auth0-secret",
    SLACK_OAUTH_AUTHORIZE_URL: settings.authorizationUrl, SLACK_CLIENT_ID: settings.clientId, SLACK_APP_ID: settings.appId };
  assert.deepEqual(readSlackConnectionSettings(env), settings);
  assert.deepEqual([...SLACK_CONNECTION_SCOPES], requiredScopes);
  for (const url of ["", "http://slack.com/oauth/v2/authorize", "https://evil.example/oauth/v2/authorize", `${settings.authorizationUrl}?scope=admin`, "https://secret@slack.com/oauth/v2/authorize", "https://slack.com/oauth/authorize", `${settings.authorizationUrl}#secret`]) {
    assert.throws(() => readSlackConnectionSettings({ ...env, SLACK_OAUTH_AUTHORIZE_URL: url }), safeError);
  }
  for (const patch of [{ SLACK_CLIENT_ID: "" }, { SLACK_APP_ID: "" }, { AUTH0_BASE_URL: "http://localhost:3000" }, { AUTH0_BASE_URL: "https://localhost" }]) assert.throws(() => readSlackConnectionSettings({ ...env, ...patch }), safeError);
});

test("Slack binding lookup scopes both tenant and provider reads and rejects inconsistent pilot metadata", async () => {
  const statements: { text: string; values: unknown[] }[] = [];
  let tenantTeam: string | null = "T123";
  let connectionRows: unknown[][] = [["T123", "U123"]];
  const pool = { async query(query: { text: string }, values: unknown[]) {
    statements.push({ text: query.text, values });
    return { rows: query.text.includes('from "tenants"') ? [[tenantTeam]] : connectionRows };
  } } as unknown as Pool;
  const db = drizzle({ client: pool, schema });
  assert.deepEqual(await loadSlackWorkspaceBinding(db, viewer), { teamId: "T123", botUserId: "U123" });
  assert.equal(statements.length, 2);
  for (const statement of statements) assert.ok(statement.values.includes(viewer.tenantId));
  assert.ok(statements[1].values.includes("slack"));
  tenantTeam = "T999";
  await assert.rejects(loadSlackWorkspaceBinding(db, viewer), safeError);
  tenantTeam = null; connectionRows = [];
  assert.equal(await loadSlackWorkspaceBinding(db, viewer), null, "A new tenant enrolls through the code + PKCE grant");
});
