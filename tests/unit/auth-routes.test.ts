import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import test, { after, afterEach, beforeEach, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { generateSessionCookie } from "@auth0/nextjs-auth0/testing";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import { NextResponse } from "next/server.js";

// Next supplies this build-time marker; the standalone Node runner does not.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

const { auth0, createAuth0Client, finishAuth0Callback, readAuth0Settings, validateReturnTo } = await import("../../src/lib/auth0.ts");
const { GET: login } = await import("../../src/app/auth/login/route.ts");
const { GET: signup } = await import("../../src/app/auth/signup/route.ts");
const { GET: logout } = await import("../../src/app/auth/logout/route.ts");
const { GET: callback } = await import("../../src/app/auth/callback/route.ts");
const settings = {
  AUTH0_SECRET: "a".repeat(64), AUTH0_BASE_URL: "https://signal.example",
  AUTH0_ISSUER_BASE_URL: "https://tenant.example.auth0.com",
  AUTH0_CLIENT_ID: "fixture-client", AUTH0_CLIENT_SECRET: "fixture-client-secret",
};
const previousEnvironment = { ...process.env };
let providerCalls = 0;
beforeEach(() => {
  Object.assign(process.env, settings);
  providerCalls = 0;
  mock.method(globalThis, "fetch", async () => { providerCalls++; throw new Error("Unexpected provider call"); });
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(settings)) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
  assert.equal(providerCalls, 0);
});

function request(route: string, returnTo?: string): Request {
  const url = new URL(`/auth/${route}`, settings.AUTH0_BASE_URL);
  if (returnTo !== undefined) url.searchParams.set("returnTo", returnTo);
  return new Request(url);
}
const unsafePaths = [
  "https://evil.example/steal", "https://signal.example/settings", "//evil.example", "///evil.example",
  "javascript:alert(1)", "settings", "?returnTo=/settings", " /settings", "/settings ",
  "/\\evil.example", "/%5cevil.example", "/%2f%2fevil.example", "/%252f%252fevil.example",
  "/safe/..//evil.example", "/%2e%2e//evil.example", "/\nevil.example", "/%0d%0aevil.example",
  "/%250aevil.example", "/%", "/%E0%A4%A", "",
];

test("server settings map the required legacy environment names to SDK v4", () => {
  assert.deepEqual(readAuth0Settings(settings), {
    secret: settings.AUTH0_SECRET, appBaseUrl: settings.AUTH0_BASE_URL,
    domain: "tenant.example.auth0.com", clientId: settings.AUTH0_CLIENT_ID, clientSecret: settings.AUTH0_CLIENT_SECRET,
  });
  assert.ok(createAuth0Client() instanceof Auth0Client);
  assert.equal(typeof auth0.getSession, "function");
});

test("missing or malformed settings fail closed without including values", () => {
  for (const key of Object.keys(settings)) {
    for (const value of [undefined, "", "   "]) {
      assert.throws(() => readAuth0Settings({ ...settings, [key]: value }), /^Error: Authentication is unavailable\.$/);
    }
  }
  for (const invalid of [
    { AUTH0_SECRET: "not-a-32-byte-hex-key" },
    { AUTH0_BASE_URL: "https://user:private@signal.example" },
    { AUTH0_BASE_URL: "https://signal.example/unexpected-path" },
    { AUTH0_BASE_URL: "http://signal.example" },
    { AUTH0_BASE_URL: "https://signal.example?private=value" },
    { AUTH0_ISSUER_BASE_URL: "http://tenant.example.auth0.com" },
    { AUTH0_ISSUER_BASE_URL: "https://tenant.example.auth0.com/wrong-issuer" },
  ]) assert.throws(() => readAuth0Settings({ ...settings, ...invalid }), /^Error: Authentication is unavailable\.$/);
  assert.equal(readAuth0Settings({ ...settings, AUTH0_BASE_URL: "http://localhost:3000" }).appBaseUrl, "http://localhost:3000");
});

test("returnTo preserves local paths, query strings and fragments", () => {
  for (const path of ["/", "/settings?tab=connections#slack", "/onboarding", "/search?q=hello%20world", "/search?q=100%25"]) {
    assert.equal(validateReturnTo(path, settings.AUTH0_BASE_URL), path);
  }
  for (const path of [...unsafePaths, null, undefined, 123]) {
    assert.equal(validateReturnTo(path, settings.AUTH0_BASE_URL), "/", String(path));
  }
});

test("anonymous login starts Universal Login and forwards only a validated returnTo", async () => {
  const expected = new NextResponse(null, { status: 302, headers: { location: "https://tenant.example.auth0.com/authorize", "set-cookie": "__txn_fixture=opaque; HttpOnly" } });
  const start = mock.method(Auth0Client.prototype, "startInteractiveLogin", async () => expected);
  const url = new URL(request("login", "/settings?tab=connections").url);
  url.searchParams.set("redirect_uri", "https://evil.example");
  url.searchParams.set("organization", "attacker-org");
  url.searchParams.set("screen_hint", "signup");
  const response = await login(new Request(url));
  assert.equal(response, expected);
  assert.deepEqual(start.mock.calls[0].arguments, [{ returnTo: "/settings?tab=connections" }]);
  assert.equal(response.headers.get("set-cookie"), "__txn_fixture=opaque; HttpOnly");
  assert.match(response.headers.get("cache-control")!, /no-store/);
});

test("login and signup reject unsafe return paths; signup always sets screen_hint", async () => {
  const start = mock.method(Auth0Client.prototype, "startInteractiveLogin", async () => NextResponse.redirect("https://tenant.example.auth0.com/authorize"));
  for (const path of unsafePaths) {
    await login(request("login", path));
    await signup(request("signup", path));
  }
  await signup(request("signup", "/onboarding"));
  assert.deepEqual(start.mock.calls.at(-1)!.arguments, [{ returnTo: "/onboarding", authorizationParameters: { screen_hint: "signup" } }]);
  for (let index = 0; index < unsafePaths.length * 2; index += 2) {
    assert.deepEqual(start.mock.calls[index].arguments, [{ returnTo: "/" }]);
    assert.deepEqual(start.mock.calls[index + 1].arguments, [{ returnTo: "/", authorizationParameters: { screen_hint: "signup" } }]);
  }
});

test("logout delegates cookie clearing to the SDK with an absolute trusted return URL", async () => {
  const expected = new NextResponse(null, { status: 302, headers: { location: "https://tenant.example.auth0.com/v2/logout", "set-cookie": "__session=; Max-Age=0" } });
  const middleware = mock.method(Auth0Client.prototype, "middleware", async () => expected);
  const input = new Request("https://evil.example/auth/logout?returnTo=%2Fgoodbye&federated&state=untrusted", {
    headers: { cookie: "__session=opaque", "x-forwarded-host": "evil.example" },
  });
  const response = await logout(input);
  const forwarded = middleware.mock.calls[0].arguments[0] as Request;
  const url = new URL(forwarded.url);
  assert.equal(url.origin, settings.AUTH0_BASE_URL);
  assert.equal(url.pathname, "/auth/logout");
  assert.deepEqual([...url.searchParams], [["returnTo", "https://signal.example/goodbye"]]);
  assert.equal(forwarded.headers.get("cookie"), "__session=opaque");
  assert.equal(response, expected);
  assert.equal(response.headers.get("set-cookie"), "__session=; Max-Age=0");
});

test("logout rejects unsafe return paths and defaults to the configured origin", async () => {
  const middleware = mock.method(Auth0Client.prototype, "middleware", async () => NextResponse.redirect("https://tenant.example.auth0.com/v2/logout"));
  for (const path of [...unsafePaths, undefined]) await logout(request("logout", path));
  for (const call of middleware.mock.calls) {
    assert.equal(new URL((call.arguments[0] as Request).url).searchParams.get("returnTo"), "https://signal.example/");
  }
});

test("real SDK logout omits the ID token from redirects and preserves safe return paths", async () => {
  const issuer = `${settings.AUTH0_ISSUER_BASE_URL}/`;
  const discovery = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(input instanceof Request ? input.url : String(input), `${issuer}.well-known/openid-configuration`);
    return Response.json({
      issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}oauth/token`,
      jwks_uri: `${issuer}.well-known/jwks.json`, end_session_endpoint: `${issuer}oidc/logout`,
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    });
  });
  // The SDK captures fetch at construction. Use a fresh configured client so
  // the real route and SDK run against this test's discovery fixture only.
  const sdkMiddleware = Auth0Client.prototype.middleware;
  const sdkClient = createAuth0Client();
  mock.method(Auth0Client.prototype, "middleware", (input: Request) => sdkMiddleware.call(sdkClient, input));
  const idToken = "fixture-private-id-token-not-for-urls";
  const cookie = await generateSessionCookie({
    user: { sub: "auth0|fixture" },
    tokenSet: { idToken, accessToken: "fixture-access-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    internal: { sid: "fixture-logout-session", createdAt: Math.floor(Date.now() / 1000) },
  }, { secret: settings.AUTH0_SECRET });

  for (const returnTo of ["/settings?tab=connections", "https://evil.example", "//evil.example"]) {
    const response = await logout(new Request(request("logout", returnTo), { headers: { cookie: `__session=${cookie}` } }));
    assert.equal(response.status, 307);
    const location = response.headers.get("location")!;
    const redirect = new URL(location);
    assert.equal(redirect.origin, settings.AUTH0_ISSUER_BASE_URL);
    assert.equal(redirect.pathname, "/oidc/logout");
    // Proves the encrypted session was loaded, so token omission is not vacuous.
    assert.equal(redirect.searchParams.get("logout_hint"), "fixture-logout-session");
    assert.equal(redirect.searchParams.get("client_id"), settings.AUTH0_CLIENT_ID);
    assert.equal(redirect.searchParams.has("id_token_hint"), false);
    assert.equal(location.includes(idToken), false);
    assert.equal(redirect.searchParams.get("post_logout_redirect_uri"), new URL(returnTo.startsWith("/settings") ? returnTo : "/", settings.AUTH0_BASE_URL).href);
    assert.equal(response.cookies.get("__session")?.value, "");
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal(discovery.mock.callCount(), 1);
});

test("callback delegates state/code verification to the SDK and ignores browser returnTo", async () => {
  const expected = new NextResponse(null, { status: 307, headers: { location: "https://signal.example/settings", "set-cookie": "__session=opaque; HttpOnly" } });
  const middleware = mock.method(Auth0Client.prototype, "middleware", async () => expected);
  const response = await callback(new Request("https://signal.example/auth/callback?code=fixture&state=fixture&returnTo=https%3A%2F%2Fevil.example", { headers: { cookie: "__txn_fixture=opaque" } }));
  const forwarded = middleware.mock.calls[0].arguments[0] as Request;
  assert.deepEqual([...new URL(forwarded.url).searchParams], [["code", "fixture"], ["state", "fixture"]]);
  assert.equal(forwarded.headers.get("cookie"), "__txn_fixture=opaque");
  assert.equal(response, expected);
});

test("real SDK rejects a missing state or an unverified transaction without a provider call", async () => {
  for (const query of ["", "?state=unknown&code=fixture", "?state=tampered&code=fixture"]) {
    const response = await callback(new Request(`https://signal.example/auth/callback${query}`, { headers: { cookie: "__txn_tampered=invalid" } }));
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Authentication is unavailable.");
  }
});

test("successful callback only redirects a verified subject to a safe transaction returnTo", async () => {
  const session: SessionData = { user: { sub: "auth0|fixture" }, tokenSet: { accessToken: "fixture", expiresAt: 1 }, internal: { sid: "fixture", createdAt: 1 } };
  for (const returnTo of ["/settings?tab=connections#slack", ...unsafePaths, undefined]) {
    const response = await finishAuth0Callback(null, { returnTo, appBaseUrl: "https://evil.example" }, session);
    assert.equal(response.status, 307);
    const expectedPath = returnTo === "/settings?tab=connections#slack" ? returnTo : "/";
    assert.equal(response.headers.get("location"), new URL(expectedPath, settings.AUTH0_BASE_URL).href);
  }
  for (const invalidSession of [null, { ...session, user: { sub: "auth0|line\nbreak" } }]) {
    const response = await finishAuth0Callback(null, { returnTo: "/settings" }, invalidSession);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
  }
});

test("all routes fail safely when Auth0 is unconfigured or throws", async () => {
  mock.method(Auth0Client.prototype, "middleware", async () => { throw new Error("private-session-error"); });
  mock.method(Auth0Client.prototype, "startInteractiveLogin", async () => { throw new Error("private-provider-error"); });
  for (const route of [login, signup, logout, callback]) {
    const response = await route(request("login"));
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Authentication is unavailable.");
    delete process.env.AUTH0_SECRET;
    assert.equal((await route(request("login"))).status, 503);
    process.env.AUTH0_SECRET = settings.AUTH0_SECRET;
  }
});

test("SDK error responses are redacted without losing cookie cleanup", async () => {
  mock.method(Auth0Client.prototype, "middleware", async () => new NextResponse("private-error-detail", { status: 400, headers: { "set-cookie": "__txn_fixture=; Max-Age=0" } }));
  const response = await callback(request("callback"));
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Authentication is unavailable.");
  assert.equal(response.headers.get("set-cookie"), "__txn_fixture=; Max-Age=0");
});

// A separate process exercises the default exported route/client and captures
// the SDK's actual stderr without mocking SDK methods or replacing console.
const discoveryFailureProbe = String.raw`
  import assert from "node:assert/strict";
  import { registerHooks } from "node:module";
  import { generateSessionCookie } from "@auth0/nextjs-auth0/testing";
  registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  } });
  const marker = "PRIV_X1";
  const issuer = process.env.AUTH0_ISSUER_BASE_URL + "/";
  let fixtureFetches = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), issuer + ".well-known/openid-configuration");
    fixtureFetches++;
    const headers = { "content-type": "application/json", "x-provider-detail": marker };
    switch (process.argv[1]) {
      case "transport": throw new Error(marker, { cause: { private_payload: marker } });
      case "issuer": return Response.json({ issuer: "https://wrong.example/", private_payload: marker }, { headers });
      case "missing-issuer": return Response.json({ private_payload: marker }, { headers });
      case "array": return Response.json([marker], { headers });
      case "oversize": return Response.json({ issuer, private_payload: marker.repeat(150_000) }, { headers });
      case "invalid-json": return new Response(marker, { headers });
      case "http": return new Response(marker, { status: 503, statusText: marker, headers });
      case "stream": return new Response(new ReadableStream({ start(controller) { controller.error(new Error(marker)); } }), { headers });
      default: throw new Error("Unexpected fixture scenario");
    }
  };
  const cookie = await generateSessionCookie({
    user: { sub: "auth0|fixture" },
    tokenSet: { accessToken: "fixture-access-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
  }, { secret: process.env.AUTH0_SECRET });
  const { GET } = await import("./src/app/auth/logout/route.ts");
  const response = await GET(new Request(process.env.AUTH0_BASE_URL + "/auth/logout?returnTo=https://evil.example", {
    headers: { cookie: "__session=" + cookie + "; __txn_fixture=opaque" },
  }));
  console.log(JSON.stringify({
    status: response.status, body: await response.text(), location: response.headers.get("location"),
    sessionCleared: response.headers.getSetCookie().some((cookie) => cookie.startsWith("__session=;") && cookie.includes("Max-Age=0")),
    transactionCleared: response.headers.getSetCookie().some((cookie) => cookie.startsWith("__txn_fixture=;") && cookie.includes("Max-Age=0")),
    cacheControl: response.headers.get("cache-control"), referrerPolicy: response.headers.get("referrer-policy"), fixtureFetches,
  }));
`;

for (const scenario of ["issuer", "missing-issuer", "array", "oversize", "invalid-json", "http", "transport", "stream"]) {
  test(`real SDK discovery failure keeps provider details out of logs: ${scenario}`, () => {
    const probe = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", discoveryFailureProbe, scenario], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), env: process.env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(probe.status, 0, probe.stderr);
    const response = JSON.parse(probe.stdout);
    assert.equal(response.status, 500);
    assert.equal(response.body, "Authentication is unavailable.");
    assert.equal(response.location, null);
    assert.equal(response.sessionCleared, true);
    assert.equal(response.transactionCleared, true);
    assert.match(response.cacheControl, /no-store/);
    assert.equal(response.referrerPolicy, "no-referrer");
    assert.equal(response.fixtureFetches, 1);
    assert.equal((probe.stderr + probe.stdout).includes("PRIV_X1"), false, "Provider fixture details must not reach logs or HTTP output");
    assert.match(probe.stderr, /AUTH0_(DISCOVERY|HTTP|TRANSPORT)_FAILURE/);
    assert.doesNotMatch(probe.stderr, /\n\s+at /, "Only a bounded diagnostic category should reach the SDK logger");
  });
}

// Shared synthetic responses exercise the SDK's real revocation/token readers.
const responseStreamFixtures = String.raw`
  let bodyCancellations = 0;
  function responseStreamFixture(scenario, marker) {
    const failure = () => new Error(marker, { cause: { detail: marker } });
    const headers = { "content-type": "application/json", "x-provider-detail": "PRIV_RESPONSE" };
    let stream;
    if (scenario === "transport-error") throw failure();
    if (["header-error", "stream-error", "http-error"].includes(scenario)) {
      stream = new ReadableStream({ start(controller) { controller.error(failure()); } });
      if (scenario === "header-error") headers["content-length"] = "1048577";
    } else if (scenario === "header-cancel") {
      headers["content-length"] = "1048577 PRIV_RESPONSE";
      stream = new ReadableStream({ cancel() { bodyCancellations++; throw failure(); } });
    } else if (["chunked-overflow", "understated-length", "late-stream-error"].includes(scenario)) {
      if (scenario === "understated-length") headers["content-length"] = "1";
      let chunks = 0;
      stream = new ReadableStream({
        pull(controller) {
          if (scenario === "late-stream-error" && chunks++) controller.error(failure());
          else controller.enqueue(new Uint8Array(524289));
        },
        cancel() { bodyCancellations++; throw failure(); },
      });
    } else if (scenario === "exact-limit") {
      headers["content-length"] = "1048576";
      return new Response(new Uint8Array(1048576), { headers });
    } else return null;
    return new Response(stream, { status: scenario === "http-error" ? 400 : 200, statusText: "PRIV_RESPONSE", headers });
  }
`;

const refreshTokenLogoutProbe = String.raw`
  import assert from "node:assert/strict";
  import { registerHooks } from "node:module";
  import { generateSessionCookie } from "@auth0/nextjs-auth0/testing";
  import { NextRequest } from "next/server.js";
  ${responseStreamFixtures}
  registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  } });
  const issuer = process.env.AUTH0_ISSUER_BASE_URL + "/";
  const base = process.env.AUTH0_BASE_URL;
  let discoveryRequests = 0;
  let revocationRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === issuer + ".well-known/openid-configuration") {
      discoveryRequests++;
      return Response.json({
        issuer, authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "oauth/token",
        jwks_uri: issuer + ".well-known/jwks.json", end_session_endpoint: issuer + "oidc/logout",
        revocation_endpoint: issuer + "oauth/revoke",
        mtls_endpoint_aliases: { revocation_endpoint: issuer + "oauth/revoke" },
        ...JSON.parse(process.argv[1]),
      });
    }
    assert.equal(String(input), issuer + "oauth/revoke");
    assert.equal(init.method, "POST");
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("token"), "fixture-private-refresh-token");
    assert.equal(form.get("token_type_hint"), "refresh_token");
    revocationRequests++;
    return responseStreamFixture(process.argv[3], "PRIV_REVOKE") ?? new Response(null, { status: 200 });
  };
  const cookie = await generateSessionCookie({
    user: { sub: "auth0|fixture" },
    tokenSet: {
      accessToken: "fixture-access-token", refreshToken: "fixture-private-refresh-token",
      idToken: "fixture-private-id-token", expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    internal: { sid: "fixture-logout-session", createdAt: Math.floor(Date.now() / 1000) },
  }, { secret: process.env.AUTH0_SECRET });
  const { auth0 } = await import("./src/lib/auth0.ts");
  const { GET } = await import("./src/app/auth/logout/route.ts");
  const headers = { cookie: "__session=" + cookie + "; __txn_fixture=opaque" };
  const session = await auth0.getSession(new NextRequest(base, { headers }));
  assert.equal(session?.tokenSet.refreshToken, "fixture-private-refresh-token");
  const url = new URL(base + "/auth/logout");
  url.searchParams.set("returnTo", process.argv[2]);
  const response = await GET(new Request(url, { headers }));
  console.log(JSON.stringify({
    status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers),
    sessionCleared: response.headers.getSetCookie().some((cookie) => cookie.startsWith("__session=;") && cookie.includes("Max-Age=0")),
    transactionCleared: response.headers.getSetCookie().some((cookie) => cookie.startsWith("__txn_fixture=;") && cookie.includes("Max-Age=0")),
    discoveryRequests, revocationRequests, bodyCancellations,
  }));
`;

function probeRefreshTokenLogout(metadata: Record<string, unknown>, returnTo = "/settings?tab=connections", responseScenario = "success") {
  const probe = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", refreshTokenLogoutProbe, JSON.stringify(metadata), returnTo, responseScenario], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), env: process.env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const output = probe.stderr + probe.stdout;
  for (const privateValue of ["PRIV_ENDPOINT", "PRIV_REVOKE", "PRIV_RESPONSE", "fixture-private-refresh-token", "fixture-private-id-token"]) {
    assert.equal(probe.stdout.includes(privateValue), false, "Provider details and tokens must not reach HTTP output");
    assert.equal(probe.stderr.includes(privateValue), false, "Provider details and tokens must not reach SDK stderr");
  }
  assert.doesNotMatch(output, /OperationProcessingError|TypeError|OAUTH_HTTP_REQUEST_FORBIDDEN|\[cause\]|\n\s+at /);
  const response = JSON.parse(probe.stdout);
  assert.equal(response.sessionCleared, true);
  assert.equal(response.transactionCleared, true);
  assert.equal(response.discoveryRequests, 1);
  assert.match(response.headers["cache-control"], /no-store/);
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  return { response, stderr: probe.stderr };
}

const privateHttpEndpoint = "http://tenant.example.auth0.com/oauth/revoke?private=PRIV_ENDPOINT";
const invalidDiscoveryEndpoints: [string, Record<string, unknown>][] = [
  ...[
    "authorization_endpoint", "token_endpoint", "jwks_uri", "registration_endpoint", "revocation_endpoint",
    "introspection_endpoint", "device_authorization_endpoint", "userinfo_endpoint",
    "pushed_authorization_request_endpoint", "backchannel_authentication_endpoint", "end_session_endpoint",
  ].map((field): [string, Record<string, unknown>] => [`HTTP ${field}`, { [field]: privateHttpEndpoint }]),
  ["FTP revocation endpoint", { revocation_endpoint: "ftp://tenant.example.auth0.com/revoke?private=PRIV_ENDPOINT" }],
  ["relative revocation endpoint", { revocation_endpoint: "/oauth/revoke?private=PRIV_ENDPOINT" }],
  ["malformed revocation URL", { revocation_endpoint: "https://[PRIV_ENDPOINT]" }],
  ["object revocation endpoint", { revocation_endpoint: { private: "PRIV_ENDPOINT" } }],
  ["null revocation endpoint", { revocation_endpoint: null }],
  ["empty revocation endpoint", { revocation_endpoint: "" }],
  ["array end-session endpoint", { end_session_endpoint: [privateHttpEndpoint] }],
  ["malformed end-session URL", { end_session_endpoint: "https://[PRIV_ENDPOINT]" }],
  ["HTTP mTLS revocation alias", { mtls_endpoint_aliases: { revocation_endpoint: privateHttpEndpoint } }],
  ["malformed mTLS aliases", { mtls_endpoint_aliases: [privateHttpEndpoint] }],
];

for (const [scenario, metadata] of invalidDiscoveryEndpoints) {
  test(`real SDK refresh-token logout rejects unsafe discovery endpoints: ${scenario}`, () => {
    const { response, stderr } = probeRefreshTokenLogout(metadata);
    assert.match(stderr, /AUTH0_DISCOVERY_FAILURE/);
    assert.equal(response.status, 500);
    assert.equal(response.body, "Authentication is unavailable.");
    // Never redirect through rejected metadata or attempt revocation over HTTP.
    assert.equal(response.headers.location, undefined);
    assert.equal(response.revocationRequests, 0);
  });
}

test("real SDK refresh-token logout still revokes over HTTPS and preserves only safe redirects", () => {
  for (const [returnTo, expected] of [
    ["/settings?tab=connections", "https://signal.example/settings?tab=connections"],
    ["https://evil.example", "https://signal.example/"],
    ["//evil.example", "https://signal.example/"],
  ]) {
    const { response, stderr } = probeRefreshTokenLogout({}, returnTo);
    assert.equal(stderr, "");
    assert.equal(response.status, 307);
    assert.equal(response.revocationRequests, 1);
    const redirect = new URL(response.headers.location);
    assert.equal(redirect.origin, "https://tenant.example.auth0.com");
    assert.equal(redirect.pathname, "/oidc/logout");
    assert.equal(redirect.searchParams.get("logout_hint"), "fixture-logout-session");
    assert.equal(redirect.searchParams.get("post_logout_redirect_uri"), expected);
    assert.equal(redirect.searchParams.has("id_token_hint"), false);
  }
});

for (const scenario of ["header-error", "header-cancel", "stream-error", "late-stream-error", "chunked-overflow", "understated-length", "http-error", "transport-error", "exact-limit"]) {
  test(`real SDK revocation response boundary contains body failures: ${scenario}`, () => {
    const { response, stderr } = probeRefreshTokenLogout({}, "/settings?tab=connections", scenario);
    assert.equal(response.status, 307);
    assert.equal(response.revocationRequests, 1);
    const redirect = new URL(response.headers.location);
    assert.equal(redirect.origin, "https://tenant.example.auth0.com");
    assert.equal(redirect.pathname, "/oidc/logout");
    assert.equal(redirect.searchParams.get("post_logout_redirect_uri"), "https://signal.example/settings?tab=connections");
    assert.equal(redirect.searchParams.has("id_token_hint"), false);
    if (scenario === "exact-limit") assert.equal(stderr, "");
    else assert.match(stderr, /AUTH0_(TRANSPORT|HTTP)_FAILURE/);
    if (["header-cancel", "chunked-overflow", "understated-length"].includes(scenario)) {
      assert.equal(response.bodyCancellations, 1);
    }
  });
}

test("real SDK callback retains PKCE, state and token-claim validation through the transport boundary", () => {
  const probe = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", String.raw`
    import assert from "node:assert/strict";
    import { createHash, generateKeyPairSync, sign } from "node:crypto";
    import { registerHooks } from "node:module";
    import { NextRequest } from "next/server.js";
    ${responseStreamFixtures}
    registerHooks({ resolve(specifier, context, nextResolve) {
      return specifier === "server-only"
        ? { url: "data:text/javascript,export {};", shortCircuit: true }
        : nextResolve(specifier, context);
    } });
    const issuer = process.env.AUTH0_ISSUER_BASE_URL + "/";
    const base = process.env.AUTH0_BASE_URL;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let nonce;
    let challenge;
    let tokenRequests = 0;
    let discoveryRequests = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === issuer + ".well-known/openid-configuration") {
        discoveryRequests++;
        return Response.json({
          issuer, authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "oauth/token",
          jwks_uri: issuer + ".well-known/jwks.json", end_session_endpoint: issuer + "oidc/logout",
          response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
          private_payload: "PRIV_X1",
        });
      }
      if (url === issuer + ".well-known/jwks.json") {
        return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }] });
      }
      assert.equal(url, issuer + "oauth/token");
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("redirect_uri"), base + "/auth/callback");
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), challenge);
      tokenRequests++;
      const failedResponse = responseStreamFixture(form.get("code"), "PRIV_TOKEN");
      if (failedResponse) return failedResponse;
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = encode({ alg: "RS256", kid: "fixture" }) + "." + encode({
        iss: form.get("code") === "wrong-issuer" ? "https://wrong.example/" : issuer,
        aud: process.env.AUTH0_CLIENT_ID, sub: "auth0|fixture", iat: now, exp: now + 3600,
        nonce: form.get("code") === "wrong-nonce" ? "wrong-nonce" : nonce,
      });
      const idToken = unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
      return Response.json({ token_type: "Bearer", access_token: "fixture-access-token", id_token: idToken, expires_in: 3600 });
    };
    const { auth0 } = await import("./src/lib/auth0.ts");
    const { GET: callback } = await import("./src/app/auth/callback/route.ts");
    const cookieHeader = (response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    for (const mode of ["valid", "wrong-state", "wrong-nonce", "wrong-issuer", "header-error", "header-cancel", "stream-error", "late-stream-error", "chunked-overflow", "understated-length", "http-error", "transport-error"]) {
      const start = await auth0.middleware(new Request(base + "/auth/login?returnTo=%2Fsettings"));
      assert.equal(start.status, 307);
      const authorization = new URL(start.headers.get("location"));
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      nonce = authorization.searchParams.get("nonce");
      challenge = authorization.searchParams.get("code_challenge");
      const url = new URL(base + "/auth/callback");
      url.searchParams.set("state", mode === "wrong-state" ? "unverified-state" : authorization.searchParams.get("state"));
      url.searchParams.set("code", mode);
      url.searchParams.set("returnTo", "https://evil.example");
      const response = await callback(new Request(url, { headers: { cookie: cookieHeader(start) } }));
      assert.doesNotMatch(JSON.stringify(Object.fromEntries(response.headers)), /PRIV_TOKEN|PRIV_RESPONSE/);
      assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__txn_") && cookie.includes("Max-Age=0")), mode !== "wrong-state");
      if (mode === "valid") {
        assert.equal(response.status, 307);
        assert.equal(response.headers.get("location"), base + "/settings");
        const session = await auth0.getSession(new NextRequest(base, { headers: { cookie: cookieHeader(response) } }));
        assert.equal(session?.user.sub, "auth0|fixture");
      } else {
        assert.equal(response.status, 400);
        assert.equal(await response.text(), "Authentication is unavailable.");
        assert.equal(response.headers.get("location"), null);
        assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__session=")), false);
      }
    }
    assert.equal(discoveryRequests, 1);
    assert.equal(tokenRequests, 11);
    console.log("PKCE/state/token-claim checks passed; external requests: 0");
  `], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: process.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stderr, "");
  assert.match(probe.stdout, /PKCE\/state\/token-claim checks passed; external requests: 0/);
});
