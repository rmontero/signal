import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import test, { after, afterEach, beforeEach, mock } from "node:test";
import type { ViewerTenant } from "../../src/lib/tenant-context.ts";
import type { OAuthStateRecord, ProviderConnectionCompletion } from "../../src/db/connection-repository.ts";
import type { OAuthStateStore } from "../../src/lib/oauth-state.ts";
import type { GitHubInstallationScope } from "../../src/adapters/github-app.ts";
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

const { createGitHubConnectionService, readGitHubConnectionSettings, resolveGitHubInstallationScope, loadGitHubInstallationScope } = await import("../../src/services/github-connection.ts");
const { verifyGitHubInstallation } = await import("../../src/adapters/github-app.ts");
const { createOAuthStateService } = await import("../../src/lib/oauth-state.ts");
const viewer: ViewerTenant = { tenantId: "tenant-a", subject: "auth0|owner-a", role: "OWNER" };
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const credentials = { appId: "123", privateKey };
const scope: GitHubInstallationScope = {
  installationId: "456", accountId: "789", accountLogin: "signal-org",
  repositories: [{ id: "321", owner: "signal-org", repo: "signal" }],
};
const settings = { appBaseUrl: "https://signal.example", installationUrl: "https://github.com/apps/signal-test/installations/new", appSlug: "signal-test", credentials };
const token = "synthetic-installation-token-do-not-serialize";
const marker = "private-provider-response-do-not-serialize";
const installation = () => ({
  id: 456, app_id: 123, app_slug: "signal-test", target_id: 789, target_type: "Organization",
  account: { id: 789, login: "signal-org", type: "Organization" },
  repository_selection: "selected", suspended_at: null, suspended_by: null,
  permissions: { metadata: "read", issues: "write", pull_requests: "read" },
  secret: marker,
});
const repository = (id = 321, name = "signal") => ({
  id, name, full_name: `signal-org/${name}`, owner: { id: 789, login: "signal-org" },
  html_url: `https://github.com/signal-org/${name}`, private_details: marker,
});

function providerFixture(change: { installation?: unknown; repositories?: unknown; token?: unknown; failure?: string; link?: string } = {}) {
  const calls: { url: string; method: string; authorization: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ url, method: init?.method ?? "GET", authorization });
    assert.equal(init?.redirect, "error");
    if (change.failure) throw new Error(change.failure);
    if (url === "https://api.github.com/app/installations/456") {
      assert.match(authorization, /^Bearer ey/);
      return Response.json(change.installation ?? installation());
    }
    if (url === "https://api.github.com/app/installations/456/access_tokens") {
      assert.equal(init?.method, "POST");
      assert.match(authorization, /^bearer ey/i);
      return Response.json(change.token ?? { token, expires_at: "2099-01-01T00:00:00Z", permissions: installation().permissions, repository_selection: "selected" }, { status: 201 });
    }
    assert.equal(authorization, `Bearer ${token}`);
    if (url === "https://api.github.com/installation/repositories?per_page=100&page=1") {
      return Response.json(change.repositories ?? { total_count: 1, repositories: [repository()] }, { headers: change.link ? { link: change.link } : {} });
    }
    if (url === "https://api.github.com/repos/signal-org/signal") return Response.json(repository());
    assert.fail(`Unexpected synthetic request: ${new URL(url).pathname}`);
  };
  return { fetchImpl, calls };
}

function fixture(providerChange: Parameters<typeof providerFixture>[0] = {}) {
  let current: ViewerTenant | null = viewer;
  let generation = 7;
  let clock = new Date("2026-09-13T00:00:00Z");
  let intended: GitHubInstallationScope | null = structuredClone(scope);
  const rows = new Map<string, OAuthStateRecord>();
  const store: OAuthStateStore = {
    async save(row, seal) { rows.set(row.stateHash, { ...row, encryptedPayload: seal(generation), consumedAt: null }); },
    async read() { throw new Error("Unused read"); },
    async consume(query) {
      const row = rows.get(query.stateHash);
      if (!row || row.consumedAt || row.tenantId !== query.tenantId || row.subject !== query.subject || row.provider !== query.provider) return null;
      row.consumedAt = clock;
      return { ...row };
    },
  };
  const oauth = createOAuthStateService({ store, resolveViewerTenant: async () => current, getEncryptionKey: () => "ab".repeat(32), now: () => clock });
  const provider = providerFixture(providerChange);
  const persisted: { completion: ProviderConnectionCompletion; [key: string]: unknown }[] = [];
  let consumed: Awaited<ReturnType<typeof oauth.consumeOAuthState>> | undefined;
  let beforeSave = () => {};
  const service = createGitHubConnectionService({
    resolveViewerTenant: async () => current,
    getSettings: () => settings,
    loadScope: async (authority) => { assert.deepEqual(authority, current); return intended; },
    createOAuthState: oauth.createOAuthState,
    consumeOAuthState: async (...args) => { consumed = await oauth.consumeOAuthState(...args); return consumed; },
    verifyInstallation: (config, expected) => verifyGitHubInstallation(config.credentials, expected, { appSlug: config.appSlug, fetchImpl: provider.fetchImpl }),
    saveConnection: async (input) => {
      beforeSave();
      assert.equal(input.completion, consumed?.completion, "The original persisted completion must be forwarded unchanged");
      if (input.completion.generation !== generation) throw new Error(marker);
      persisted.push(input);
      generation++;
      return { connectionId: "connection-a", installationId: input.installationId };
    },
  });
  async function start(returnTo = "/settings") {
    const response = await service.beginGitHubInstallation(current, returnTo);
    return new URL(response.headers.get("location")!).searchParams.get("state")!;
  }
  return { service, start, rows, oauth, persisted, provider, setViewer(value: ViewerTenant | null) { current = value; },
    setScope(value: GitHubInstallationScope | null) { intended = value; },
    expire() { clock = new Date(clock.getTime() + 600_001); },
    disconnectDuringCompletion() { beforeSave = () => { generation++; }; },
  };
}

const request = (part: string, query = "") => new Request(`https://signal.example/api/settings/connections/github/${part}${query}`);
async function safeResponse(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const output = `${JSON.stringify([...response.headers])} ${await response.text()}`;
  for (const secret of [token, marker, privateKey, "encryptedPayload", "stateHash", "pkceVerifier", "generation"]) assert.equal(output.includes(secret), false);
  return output;
}

test("GitHub start/callback deny anonymous and non-admin viewers before state or provider access", async () => {
  for (const authority of [null, { ...viewer, role: "MEMBER" as const }]) {
    const f = fixture(); f.setViewer(authority);
    for (const route of ["start", "callback"] as const) await safeResponse(await f.service.handleRoute(request(route), route), authority ? 403 : 401);
    assert.equal(f.rows.size, 0); assert.equal(f.provider.calls.length, 0); assert.equal(f.persisted.length, 0);
  }
});

test("GitHub start binds single-use state to the verified tenant/admin and validates local returnTo", async () => {
  const f = fixture();
  f.setViewer({ ...viewer, role: "ADMIN" });
  const response = await f.service.handleRoute(request("start", "?returnTo=%2Fsettings%3Ftab%3Dconnections%23github"), "start");
  const location = new URL(response.headers.get("location")!);
  await safeResponse(response, 303);
  assert.equal(location.origin + location.pathname, settings.installationUrl);
  assert.deepEqual([...location.searchParams.keys()], ["state"]);
  const row = [...f.rows.values()][0]!;
  assert.equal(row.tenantId, viewer.tenantId); assert.equal(row.subject, viewer.subject); assert.equal(row.provider, "github");
  assert.equal(row.returnTo, "/settings?tab=connections#github"); assert.equal(f.provider.calls.length, 0);
});

test("GitHub start rejects external/ambiguous return paths and browser authority", async () => {
  for (const returnTo of ["https://evil.example", "//evil.example", "/\\evil.example", "/%252f%252fevil.example", "/%0aevil"]) {
    const f = fixture();
    await safeResponse(await f.service.handleRoute(request("start", `?returnTo=${encodeURIComponent(returnTo)}`), "start"), 400);
    assert.equal(f.rows.size, 0);
  }
  for (const query of ["?tenantId=other", "?installation_id=999", "?repository=other", "?returnTo=/settings&returnTo=/", "?access_token=private"]) {
    const f = fixture(); await safeResponse(await f.service.handleRoute(request("start", query), "start"), 400); assert.equal(f.rows.size, 0);
  }
});

test("GitHub requires server-bound scope and never accepts a caller-forged viewer", async () => {
  const f = fixture(); f.setScope(null);
  await safeResponse(await f.service.handleRoute(request("start"), "start"), 503);
  assert.equal(f.rows.size, 0);
  await assert.rejects(f.service.beginGitHubInstallation({ ...viewer, tenantId: "other" }, "/settings"), /GitHub connection is unavailable/);
});

test("GitHub callback rejects state mismatch, expiry, replay and cross-tenant/subject/provider state", async () => {
  for (const mode of ["mismatch", "expiry", "tenant", "subject", "provider", "replay"]) {
    const f = fixture(); let state = await f.start();
    if (mode === "mismatch") state = "A".repeat(43);
    if (mode === "expiry") f.expire();
    if (mode === "tenant") f.setViewer({ ...viewer, tenantId: "other" });
    if (mode === "subject") f.setViewer({ ...viewer, subject: "auth0|other" });
    if (mode === "provider") state = await f.oauth.createOAuthState({ tenantId: viewer.tenantId, subject: viewer.subject, provider: "slack", returnTo: "/settings" });
    if (mode === "replay") await f.oauth.consumeOAuthState(state, { subject: viewer.subject, provider: "github" });
    await safeResponse(await f.service.handleRoute(request("callback", `?state=${state}&installation_id=456`), "callback"), 400);
    assert.equal(f.provider.calls.length, 0); assert.equal(f.persisted.length, 0);
  }
});

test("GitHub callback rejects missing/invalid/mismatched installation IDs and ambiguous query data", async () => {
  for (const query of ["", "&installation_id=", "&installation_id=0", "&installation_id=0456", "&installation_id=999", "&installation_id=456&installation_id=456", "&installation_id=456&setup_action=request", "&installation_id=456&account_id=789", "&installation_id=456&error_description=private"]) {
    const f = fixture(); const state = await f.start();
    await safeResponse(await f.service.handleRoute(request("callback", `?state=${state}${query}`), "callback"), 400);
    assert.equal(f.provider.calls.length, 0); assert.equal(f.persisted.length, 0);
  }
});

test("GitHub completion saves only verified metadata and preserves the completion fence", async () => {
  const f = fixture(); const state = await f.start();
  const result = await f.service.completeGitHubInstallation({ state, installationId: "456" });
  assert.deepEqual(result, { connectionId: "connection-a", installationId: "456" });
  const saved = f.persisted[0]!;
  assert.deepEqual(Object.keys(saved).sort(), ["completion", "displayName", "externalAccountId", "installationId", "provider", "scopes"]);
  assert.equal(saved.externalAccountId, "789"); assert.equal(saved.displayName, "signal-org");
  assert.deepEqual(saved.scopes, ["issues:write", "metadata:read", "pull_requests:read"]);
  assert.equal(saved.completion.generation, 7);
  for (const secret of [token, marker, privateKey]) assert.equal(JSON.stringify({ result, saved }).includes(secret), false);
  await assert.rejects(f.service.completeGitHubInstallation({ state, installationId: "456" }));
  assert.equal(f.persisted.length, 1);
});

test("GitHub callback redirects to the saved return path and explicitly requires a separate mapping step", async () => {
  const f = fixture(); const state = await f.start("/settings?tab=connections#github");
  const response = await f.service.handleRoute(request("callback", `?state=${state}&installation_id=456&setup_action=install`), "callback");
  const destination = new URL(response.headers.get("location")!);
  assert.equal(destination.origin, settings.appBaseUrl); assert.equal(destination.pathname, "/settings");
  assert.equal(destination.searchParams.get("tab"), "connections"); assert.equal(destination.hash, "#github");
  assert.equal(destination.searchParams.get("next"), "repository-channel-mapping");
  assert.match(await safeResponse(response, 303), /mapping is a separate next step/);
  assert.equal(f.persisted.length, 1);
});

test("a disconnect during verification rejects the stale completion without persisting metadata", async () => {
  const f = fixture(); const state = await f.start(); f.disconnectDuringCompletion();
  await safeResponse(await f.service.handleRoute(request("callback", `?state=${state}&installation_id=456`), "callback"), 503);
  assert.equal(f.persisted.length, 0);
});

test("GitHub App verification rejects missing/mismatched account, App, installation, permissions and repository scope", async () => {
  const badInstallations = [
    { ...installation(), id: 999 }, { ...installation(), app_id: 999 }, { ...installation(), app_slug: "other" },
    { ...installation(), account: null }, { ...installation(), account: { id: 999, login: "signal-org", type: "Organization" } },
    { ...installation(), account: { id: 789, login: "other", type: "Organization" } }, { ...installation(), target_id: 999 },
    { ...installation(), target_type: "User" }, { ...installation(), suspended_at: "2026-09-13T00:00:00Z" },
    { ...installation(), repository_selection: null }, { ...installation(), permissions: { metadata: "read", issues: "read" } },
  ];
  for (const value of badInstallations) {
    const p = providerFixture({ installation: value });
    await assert.rejects(verifyGitHubInstallation(credentials, scope, { appSlug: "signal-test", fetchImpl: p.fetchImpl }), /^Error: GitHub installation verification is unavailable\.$/);
    assert.equal(p.calls.length, 1, "Reject installation identity before minting a token");
  }
  for (const repositories of [
    {}, { total_count: 0, repositories: [] }, { total_count: 2, repositories: [repository()] },
    { total_count: 2, repositories: [repository(), repository()] },
    { total_count: 1, repositories: [{ ...repository(), owner: { id: 999, login: "signal-org" } }] },
    { total_count: 1, repositories: [{ ...repository(), full_name: "other/signal" }] },
    { total_count: 1, repositories: [repository(999)] },
  ]) {
    const p = providerFixture({ repositories });
    await assert.rejects(verifyGitHubInstallation(credentials, scope, { appSlug: "signal-test", fetchImpl: p.fetchImpl }), /^Error: GitHub installation verification is unavailable\.$/);
  }
});

test("account verification failures consume state and never persist or echo upstream responses", async () => {
  const f = fixture({ installation: { ...installation(), account: { id: 999, login: "other", type: "Organization" } } });
  const state = await f.start();
  await safeResponse(await f.service.handleRoute(request("callback", `?state=${state}&installation_id=456`), "callback"), 400);
  assert.ok([...f.rows.values()][0].consumedAt);
  assert.equal(f.persisted.length, 0);
  assert.equal(f.provider.calls.length, 1);
  await safeResponse(await f.service.handleRoute(request("callback", `?state=${state}&installation_id=456`), "callback"), 400);
  assert.equal(f.provider.calls.length, 1);
});

test("reconnecting a persisted account without channel mappings verifies access but never selects a repository", async () => {
  const f = fixture(); f.setScope({ ...scope, repositories: [] });
  const state = await f.start();
  assert.deepEqual(await f.service.completeGitHubInstallation({ state, installationId: "456" }), { connectionId: "connection-a", installationId: "456" });
  assert.equal(f.provider.calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(f.provider.calls.find((call) => call.method === "POST")!.url.endsWith("/access_tokens"));
  assert.equal(f.provider.calls.some((call) => call.url.includes("/repos/")), false);
  assert.equal(Object.keys(f.persisted[0]).some((key) => /repository|channel/i.test(key)), false);
});

test("GitHub default GET routes deny unauthenticated requests with safe responses", async () => {
  const { GET: startRoute } = await import("../../src/app/api/settings/connections/github/start/route.ts");
  const { GET: callbackRoute } = await import("../../src/app/api/settings/connections/github/callback/route.ts");
  await safeResponse(await startRoute(request("start")), 401);
  await safeResponse(await callbackRoute(request("callback", "?state=private&installation_id=999")), 401);
});

test("GitHub scope reads select safe fields and bind every SQL query to the server tenant", async () => {
  const statements: { text: string; values: unknown[] }[] = [];
  const client = {
    async query(query: { text: string }, values: unknown[]) {
      statements.push({ text: query.text, values });
      if (query.text.includes('from "provider_connections"')) return { rows: [["456", "789", "signal-org"]] };
      if (query.text.includes('from "channel_mappings"')) return { rows: [["456", "321", "signal-org", "signal"]] };
      throw new Error(marker);
    },
  };
  const db = drizzle(client as unknown as Pool, { schema });
  assert.deepEqual(await loadGitHubInstallationScope(db, viewer), scope);
  assert.equal(statements.length, 2);
  for (const query of statements) {
    assert.ok(query.values.includes(viewer.tenantId));
    assert.match(query.text, /"tenant_id" = \$1/);
    assert.doesNotMatch(query.text, /encrypted_secret|auth0_subject/);
    assert.match(query.text, /^select /);
  }
  assert.ok(statements[0].values.includes("github"));
  assert.ok(statements[1].values.includes(true));
  await assert.rejects(loadGitHubInstallationScope(db, { ...viewer, role: "MEMBER" }));
  assert.equal(statements.length, 2);
});

test("GitHub repository read-back detects changed IDs after installation inventory verification", async () => {
  const p = providerFixture();
  const fetchImpl: typeof fetch = (input, init) => String(input).includes("/repos/")
    ? Promise.resolve(Response.json(repository(999))) : p.fetchImpl(input, init);
  await assert.rejects(verifyGitHubInstallation(credentials, scope, { appSlug: "signal-test", fetchImpl }), /GitHub installation verification is unavailable/);
});

test("GitHub token exchange must confirm the verified permissions and repository selection", async () => {
  const valid = { token, expires_at: "2099-01-01T00:00:00Z", permissions: installation().permissions, repository_selection: "selected" };
  for (const invalid of [{ ...valid, token: "" }, { ...valid, permissions: { metadata: "read", issues: "read", pull_requests: "read" } }, { ...valid, repository_selection: "all" }]) {
    const p = providerFixture({ token: invalid });
    await assert.rejects(verifyGitHubInstallation(credentials, scope, { appSlug: "signal-test", fetchImpl: p.fetchImpl }), /GitHub installation verification is unavailable/);
    assert.equal(p.calls.length, 2);
  }
});

test("GitHub repository pagination is complete, bounded and cannot redirect installation credentials", async () => {
  const p = providerFixture();
  for (const mode of ["success", "foreign-link", "missing-page", "changed-total", "duplicate-id"]) {
    let pages = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!String(input).includes("/installation/repositories?")) return p.fetchImpl(input, init);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      const page = Number(new URL(String(input)).searchParams.get("page"));
      pages++;
      const items = page === 1 ? Array.from({ length: 100 }, (_, index) => repository(1000 + index, `repo-${index}`)) : [repository()];
      if (page === 2 && mode === "missing-page") items.length = 0;
      if (page === 2 && mode === "duplicate-id") items[0] = repository(1000, "repo-0");
      return Response.json({ total_count: page === 2 && mode === "changed-total" ? 102 : 101, repositories: items }, { headers: page === 1 ? {
        link: `<https://${mode === "foreign-link" ? "evil.example" : "api.github.com"}/installation/repositories?page=2&per_page=100>; rel="next"`,
      } : {} });
    };
    if (mode === "success") {
      const result = await verifyGitHubInstallation(credentials, scope, { appSlug: "signal-test", fetchImpl });
      assert.equal(result.installationId, "456"); assert.equal(pages, 2);
    } else await assert.rejects(verifyGitHubInstallation(credentials, scope, { appSlug: "signal-test", fetchImpl }), /GitHub installation verification is unavailable/);
  }
});

test("GitHub verification bounds provider waits and bodies and redacts HTTP/JSON/stream errors without logs", async () => {
  const output: unknown[] = [];
  for (const method of ["log", "warn", "error", "debug", "info"] as const) mock.method(console, method, (...args: unknown[]) => { output.push(args); });
  const responses = [
    () => new Response(marker, { status: 403 }),
    () => new Response(marker, { status: 302, headers: { location: "https://evil.example" } }),
    () => new Response(marker),
    () => new Response(marker, { headers: { "content-length": "2000001" } }),
    () => new Response("x".repeat(2_000_001)),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(marker)); } })),
  ];
  for (const response of responses) await assert.rejects(verifyGitHubInstallation(credentials, scope, {
    appSlug: "signal-test", fetchImpl: async () => response(),
  }), /^Error: GitHub installation verification is unavailable\.$/);
  await assert.rejects(verifyGitHubInstallation(credentials, scope, {
    appSlug: "signal-test", timeoutMs: 10, fetchImpl: async () => new Promise<Response>(() => {}),
  }), /^Error: GitHub installation verification is unavailable\.$/);
  assert.deepEqual(output, []);
});

test("GitHub provider failures redact credentials, response text, transport errors and causes", async () => {
  const p = providerFixture({ failure: `${token} ${marker} ${privateKey}` });
  await assert.rejects(verifyGitHubInstallation(credentials, scope, { appSlug: "signal-test", fetchImpl: p.fetchImpl }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.cause, undefined);
    for (const secret of [token, marker, privateKey]) assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(secret), false);
    return true;
  });
});

test("GitHub configured install URL cannot redirect credentials or use a personal OAuth route", () => {
  const env = { AUTH0_SECRET: "ab".repeat(32), AUTH0_BASE_URL: settings.appBaseUrl, AUTH0_ISSUER_BASE_URL: "https://auth.example", AUTH0_CLIENT_ID: "synthetic", AUTH0_CLIENT_SECRET: "synthetic", GITHUB_APP_ID: credentials.appId, GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_INSTALLATION_URL: settings.installationUrl };
  assert.deepEqual(readGitHubConnectionSettings(env), settings);
  for (const url of ["https://evil.example/apps/signal-test/installations/new", "https://github.com/login/oauth/authorize", `${settings.installationUrl}?token=${token}`, `https://user:${token}@github.com/apps/signal-test/installations/new`, "http://github.com/apps/signal-test/installations/new"]) {
    assert.throws(() => readGitHubConnectionSettings({ ...env, GITHUB_APP_INSTALLATION_URL: url }), /^Error: GitHub connection is unavailable\.$/);
  }
});

test("server scope requires one consistent persisted installation/account and explicit mapped repository identities", () => {
  const binding = { installationId: "456", externalAccountId: "789", displayName: "signal-org" };
  const mapping = { installationId: "456", repositoryId: "321", repositoryOwner: "signal-org", repositoryName: "signal" };
  assert.deepEqual(resolveGitHubInstallationScope([binding], [mapping]), scope);
  assert.deepEqual(resolveGitHubInstallationScope([binding], []), { ...scope, repositories: [] });
  assert.deepEqual(resolveGitHubInstallationScope([], [mapping]), { ...scope, accountId: undefined });
  assert.equal(resolveGitHubInstallationScope([], []), null);
  for (const [connections, mappings] of [
    [[binding, binding], [mapping]], [[binding], [{ ...mapping, installationId: "999" }]],
    [[binding], [{ ...mapping, repositoryOwner: "other" }]],
    [[], [mapping, { ...mapping, repositoryId: "999" }]],
  ] as [typeof binding[], typeof mapping[]][]) assert.throws(() => resolveGitHubInstallationScope(connections, mappings));
});
