import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, beforeEach, mock } from "node:test";
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
