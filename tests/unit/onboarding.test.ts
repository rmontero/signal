import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import test, { after, afterEach, beforeEach, mock } from "node:test";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import type { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { NextRequest } from "next/server.js";
import { renderToStaticMarkup } from "react-dom/server";
import { schema } from "../../src/db/schema.ts";
import type { SignalDb } from "../../src/db/client.ts";
import type { Membership } from "../../src/lib/tenant-context.ts";

// Only persistence is replaced for route/action tests. Auth0's real SDK verifies
// signed ID tokens, encrypted transaction cookies, nonce, state and PKCE below.
const fixtureGlobal = globalThis as typeof globalThis & {
  __task2Db: () => { db: SignalDb; pool: { end(): Promise<void> } };
};
// The runtime is Node 24; the pinned Node 20 declarations predate sync hooks.
type Resolve = (specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => ResolveFnOutput) => ResolveFnOutput;
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    if (/\/db\/client(?:\.ts)?$/.test(specifier)) {
      return { url: "data:text/javascript,export function createDb(){return globalThis.__task2Db();}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { createTenantForSubject, findMembershipBySubject, requireTenantAdmin } = await import("../../src/db/membership-repository.ts");
const { createWorkspace } = await import("../../src/app/onboarding/actions.ts");
const { default: OnboardingPage } = await import("../../src/app/onboarding/page.tsx");
const { GET: callback } = await import("../../src/app/auth/callback/route.ts");
const { auth0 } = await import("../../src/lib/auth0.ts");
const { resolveViewerTenant } = await import("../../src/lib/tenant-context.ts");

const settings = {
  AUTH0_SECRET: "c".repeat(64), AUTH0_BASE_URL: "https://signal.example",
  AUTH0_ISSUER_BASE_URL: "https://task2.example.auth0.com", AUTH0_CLIENT_ID: "fixture", AUTH0_CLIENT_SECRET: "fixture",
};
const previous = { ...process.env };
const member: Membership = { subject: "auth0|Verified-123", tenantId: "tenant-a", role: "OWNER", active: true, tenantActive: true };
let rows: unknown[][];
let statements: Array<{ text: string; values: unknown[] }>;
let failSql: string | undefined;
let opened: number;
let closed: number;
let failClose: boolean;
let providerFetch: typeof fetch;
const db = drizzle({
  async query(query: { text: string }, values: unknown[] = []) {
    statements.push({ text: query.text, values });
    if (failSql && query.text.includes(failSql)) throw new Error("PRIVATE_DATABASE_DETAILS", { cause: "PRIVATE_SUBJECT" });
    return { rows: query.text.includes('from "tenant_memberships"') ? rows : [], rowCount: 0 };
  },
} as unknown as Pool, { schema });
function setMembership(value: Membership | null) {
  rows = value ? [[value.subject, value.tenantId, value.role, value.active, value.tenantActive]] : [];
}
function sessionFor(subject: unknown = member.subject) {
  mock.method(Auth0Client.prototype, "getSession", async () => ({
    user: { sub: subject, email: "private@example.invalid", tenantId: "attacker", role: "OWNER" },
    tokenSet: { accessToken: "fixture-access", expiresAt: 1 }, internal: { sid: "fixture", createdAt: 1 },
  }) as SessionData);
}
beforeEach(() => {
  Object.assign(process.env, settings);
  rows = []; statements = []; failSql = undefined; opened = 0; closed = 0; failClose = false;
  fixtureGlobal.__task2Db = () => {
    opened++;
    return { db, pool: { end: async () => { closed++; if (failClose) throw new Error("PRIVATE_CLOSE"); } } };
  };
  providerFetch = async () => { throw new Error("External requests are disabled"); };
  mock.method(globalThis, "fetch", (...args: Parameters<typeof fetch>) => providerFetch(...args));
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(settings)) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test("lookup normalizes opaque subjects, binds parameters and joins the matching tenant", async () => {
  setMembership(member);
  assert.deepEqual(await findMembershipBySubject(db, "  auth0|Verified-123  "), member);
  assert.deepEqual(statements[0].values, ["auth0|Verified-123", 2]);
  assert.match(statements[0].text, /inner join "tenants" on "tenant_memberships"\."tenant_id" = "tenants"\."id"/);
  assert.doesNotMatch(statements[0].text, /Verified-123/);
  for (const invalid of ["", " ", "auth0|two words", "auth0|line\nbreak", "a".repeat(256), "auth0|é"]) {
    assert.equal(await findMembershipBySubject(db, invalid), null);
  }
  assert.equal(statements.length, 1);
});

test("lookup projects inactive flags, denies ambiguity and never substitutes another subject", async () => {
  setMembership({ ...member, active: false, tenantActive: false });
  assert.deepEqual(await findMembershipBySubject(db, member.subject), { ...member, active: false, tenantActive: false });
  rows.push([member.subject, "other-tenant", "MEMBER", true, true]);
  assert.equal(await findMembershipBySubject(db, member.subject), null);
  setMembership({ ...member, subject: "auth0|Other" });
  assert.equal(await findMembershipBySubject(db, member.subject), null);
});

test("repository errors do not carry SQL, parameters or original causes", async () => {
  failSql = "select";
  await assert.rejects(findMembershipBySubject(db, member.subject), (error) => {
    assert.equal((error as Error).message, "Tenant membership is unavailable.");
    assert.equal((error as Error).cause, undefined);
    return true;
  });
});

test("first signup generates an opaque tenant, a safe default name and an OWNER in one transaction", async () => {
  const result = await createTenantForSubject(db, { subject: ` ${member.subject} `, tenantName: " " });
  assert.match(result.tenantId, /^[a-f0-9-]{36}$/);
  assert.equal(result.role, "OWNER");
  assert.match(statements[0].text, /^begin/);
  assert.match(statements[1].text, /pg_advisory_xact_lock/);
  assert.deepEqual(statements[1].values, ["signal:onboarding:auth0|Verified-123"]);
  const tenantInsert = statements.find((query) => query.text.startsWith('insert into "tenants"'))!;
  assert.ok(tenantInsert.values.includes(result.tenantId));
  assert.ok(tenantInsert.values.includes("My workspace"));
  assert.ok(!tenantInsert.values.includes(member.subject));
  const membershipInsert = statements.find((query) => query.text.startsWith('insert into "tenant_memberships"'))!;
  assert.ok(membershipInsert.values.includes(result.tenantId));
  assert.ok(membershipInsert.values.includes(member.subject));
  assert.ok(membershipInsert.values.includes("OWNER"));
  assert.equal(statements.at(-1)?.text, "commit");
});

test("repeat signup returns the existing OWNER and does not rename or insert", async () => {
  setMembership(member);
  assert.deepEqual(await createTenantForSubject(db, { subject: member.subject, tenantName: "Replacement" }), { tenantId: "tenant-a", role: "OWNER" });
  assert.ok(statements.some((query) => /for update/.test(query.text)));
  assert.ok(statements.every((query) => !/^(insert|update)/.test(query.text)));
});

test("inactive, ambiguous, non-owner and cross-subject records cannot create replacement authority", async () => {
  for (const value of [{ ...member, active: false }, { ...member, tenantActive: false }, { ...member, role: "MEMBER" as const }, { ...member, role: "ADMIN" as const }, { ...member, subject: "other" }]) {
    statements = []; setMembership(value);
    await assert.rejects(createTenantForSubject(db, { subject: member.subject, tenantName: "Bypass" }), /^Error: Tenant setup is unavailable\.$/);
    assert.equal(statements.at(-1)?.text, "rollback");
    assert.ok(statements.every((query) => !query.text.startsWith("insert")));
  }
  setMembership(member); rows.push([...rows[0]]);
  await assert.rejects(createTenantForSubject(db, { subject: member.subject, tenantName: "Bypass" }));
});

test("signup rejects malformed identity and names before writing and contains failed writes", async () => {
  for (const input of [{ subject: "", tenantName: "Workspace" }, { subject: member.subject, tenantName: "x".repeat(121) }, { subject: member.subject, tenantName: "bad\nname" }]) {
    await assert.rejects(createTenantForSubject(db, input), /^Error: Tenant setup is unavailable\.$/);
  }
  assert.equal(statements.length, 0);
  failSql = 'insert into "tenant_memberships"';
  await assert.rejects(createTenantForSubject(db, { subject: member.subject, tenantName: "Workspace" }), /^Error: Tenant setup is unavailable\.$/);
  assert.equal(statements.at(-1)?.text, "rollback");
});

test("admin guard admits only complete OWNER/ADMIN authority", () => {
  requireTenantAdmin(member);
  requireTenantAdmin({ ...member, role: "ADMIN" });
  for (const viewer of [null, { ...member, role: "MEMBER" }, { ...member, subject: "" }, { ...member, tenantId: "bad tenant" }]) {
    assert.throws(() => requireTenantAdmin(viewer as Membership | null), /^Error: Tenant administration is unavailable\.$/);
  }
});

test("default tenant resolver is bound to membership persistence and ignores browser claims", async () => {
  sessionFor(); setMembership(member);
  assert.deepEqual(await resolveViewerTenant(), { subject: member.subject, tenantId: "tenant-a", role: "OWNER" });
  assert.equal(opened, 1); assert.equal(closed, 1);
  setMembership({ ...member, tenantActive: false });
  assert.equal(await resolveViewerTenant(), null);
});

function redirectsTo(destination: string) {
  return (error: unknown) => typeof error === "object" && error !== null && "digest" in error && String(error.digest).includes(`;${destination};`);
}

test("onboarding page and action require a verified subject before opening the database", async () => {
  sessionFor(null);
  await assert.rejects(OnboardingPage({ searchParams: Promise.resolve({}) }), redirectsTo("/auth/login?returnTo=%2Fonboarding"));
  await assert.rejects(createWorkspace(new FormData()), redirectsTo("/auth/login?returnTo=%2Fonboarding"));
  assert.equal(opened, 0);
});

test("onboarding action creates only the session subject and ignores browser tenant, role and redirect fields", async () => {
  sessionFor();
  const form = new FormData();
  for (const [key, value] of Object.entries({ subject: "auth0|Attacker", email: "attacker@example.invalid", tenantId: "attacker-tenant", role: "ADMIN", returnTo: "https://evil.example", tenantName: "  Our workspace  " })) form.set(key, value);
  await assert.rejects(createWorkspace(form), redirectsTo("/"));
  const values = statements.flatMap((query) => query.values);
  assert.ok(values.includes(member.subject)); assert.ok(values.includes("Our workspace"));
  for (const forbidden of ["auth0|Attacker", "attacker@example.invalid", "attacker-tenant", "ADMIN", "https://evil.example"]) assert.ok(!values.includes(forbidden));
  assert.equal(closed, 1);
});

test("onboarding action exposes only a fixed error destination on database, permission or form failures", async () => {
  sessionFor(); failSql = "select"; failClose = true;
  await assert.rejects(createWorkspace(new FormData()), redirectsTo("/onboarding?error=unavailable"));
  assert.equal(closed, 1);
  failSql = undefined; failClose = false; setMembership({ ...member, role: "MEMBER" });
  await assert.rejects(createWorkspace(new FormData()), redirectsTo("/onboarding?error=unavailable"));
  const file = new FormData(); file.set("tenantName", new Blob(["private"]), "private.txt");
  statements = [];
  await assert.rejects(createWorkspace(file), redirectsTo("/onboarding?error=unavailable"));
  assert.ok(statements.every((query) => !query.text.startsWith("insert")));
});

test("onboarding page renders an accessible form without identity or private errors", async () => {
  sessionFor();
  const html = renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve({ error: "unavailable", subject: "PRIVATE_QUERY" }) }));
  assert.match(html, /<label[^>]*for="tenantName"/);
  assert.match(html, /name="tenantName"/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /Verified-123|private@example|PRIVATE_QUERY|tenant-a/);
  assert.equal(closed, 1);
});

test("existing members leave onboarding and inactive memberships cannot see the creation form", async () => {
  sessionFor(); setMembership({ ...member, role: "MEMBER" });
  await assert.rejects(OnboardingPage({ searchParams: Promise.resolve({}) }), redirectsTo("/"));
  setMembership({ ...member, active: false });
  assert.doesNotMatch(renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve({}) })), /<form/);
  failSql = "select";
  const html = renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve({}) }));
  assert.doesNotMatch(html, /<form|PRIVATE_DATABASE|PRIVATE_SUBJECT/);
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
async function sdkCallback(code: string, returnTo = "/settings", wrongState = false) {
  let nonce = ""; let challenge = "";
  const issuer = settings.AUTH0_ISSUER_BASE_URL + "/";
  providerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === issuer + ".well-known/openid-configuration") return Response.json({
      issuer, authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "oauth/token", jwks_uri: issuer + ".well-known/jwks.json",
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    });
    if (url === issuer + ".well-known/jwks.json") return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }] });
    assert.equal(url, issuer + "oauth/token");
    const form = new URLSearchParams(init?.body as string);
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge);
    assert.equal(form.get("redirect_uri"), settings.AUTH0_BASE_URL + "/auth/callback");
    assert.equal(form.get("code"), code);
    if (code === "transport-error") throw new Error("PRIVATE_TRANSPORT", { cause: "PRIVATE_CAUSE" });
    if (code === "http-error") return new Response("PRIVATE_BODY", { status: 503 });
    if (code === "header-error" || code === "stream-error") return new Response(new ReadableStream({
      start(controller) { controller.error(new Error("PRIVATE_STREAM")); },
    }), { headers: code === "header-error" ? { "content-length": "1048577" } : {} });
    if (code === "header-cancel") return new Response(new ReadableStream({
      cancel() { return Promise.reject(new Error("PRIVATE_CANCEL")); },
    }), { headers: { "content-length": "1048577" } });
    if (code === "late-stream-error") {
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (sent) controller.error(new Error("PRIVATE_LATE_STREAM"));
        else { sent = true; controller.enqueue(new TextEncoder().encode("{")); }
      } }));
    }
    if (code === "chunked-overflow" || code === "understated-length") return new Response(new Uint8Array(1048577), {
      headers: code === "understated-length" ? { "content-length": "1" } : {},
    });
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = encode({ alg: "RS256", kid: "fixture" }) + "." + encode({
      iss: code === "wrong-issuer" ? "https://wrong.example/" : issuer,
      aud: code === "wrong-audience" ? "wrong-client" : settings.AUTH0_CLIENT_ID,
      sub: member.subject, email: "PRIVATE_EMAIL", iat: now - 120, exp: code === "expired" ? now - 120 : now + 3600,
      nonce: code === "wrong-nonce" ? "invalid" : nonce,
    });
    return Response.json({ token_type: "Bearer", access_token: "PRIVATE_ACCESS", expires_in: 3600,
      id_token: unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url") });
  };
  const start = await auth0.middleware(new Request(settings.AUTH0_BASE_URL + "/auth/login?returnTo=" + encodeURIComponent(returnTo)));
  const authorization = new URL(start.headers.get("location")!);
  nonce = authorization.searchParams.get("nonce")!;
  challenge = authorization.searchParams.get("code_challenge")!;
  const cookies = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  const result = await callback(new Request(settings.AUTH0_BASE_URL + "/auth/callback?" + new URLSearchParams({
    state: wrongState ? "invalid-state" : authorization.searchParams.get("state")!, code, returnTo: "https://evil.example", subject: "auth0|Attacker", tenantId: "attacker",
  }), { headers: { cookie: cookies(start) } }));
  return { result, cookies };
}

test("real SDK callback sends a new verified subject to onboarding and persists its session", async () => {
  const { result, cookies } = await sdkCallback("valid");
  assert.equal(result.status, 307);
  assert.equal(result.headers.get("location"), settings.AUTH0_BASE_URL + "/onboarding");
  assert.equal((await auth0.getSession(new NextRequest(settings.AUTH0_BASE_URL, { headers: { cookie: cookies(result) } })))?.user.sub, member.subject);
  assert.ok(result.headers.getSetCookie().some((cookie) => cookie.startsWith("__txn_") && cookie.includes("Max-Age=0")));
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(statements[0].values, [member.subject, 2]);
  assert.ok(statements.every((query) => !query.text.startsWith("insert")));
});

test("real SDK callback uses only the trusted local return path for an active membership", async () => {
  setMembership(member);
  for (const [returnTo, expected] of [["/settings?tab=connections#slack", "/settings?tab=connections#slack"], ["//evil.example", "/"], ["/%252f%252fevil.example", "/"]]) {
    const { result } = await sdkCallback("valid", returnTo);
    assert.equal(result.headers.get("location"), settings.AUTH0_BASE_URL + expected);
  }
});

test("real SDK rejects unverified callback input before membership lookup", async () => {
  for (const mode of ["wrong-state", "wrong-nonce", "wrong-issuer", "wrong-audience", "expired"]) {
    const { result } = await sdkCallback(mode, "/settings", mode === "wrong-state");
    assert.equal(result.status, 400);
    assert.equal(await result.text(), "Authentication is unavailable.");
    assert.equal(result.headers.get("location"), null);
    assert.ok(!result.headers.getSetCookie().some((cookie) => cookie.startsWith("__session=")));
    if (mode !== "wrong-state") assert.ok(result.headers.getSetCookie().some((cookie) => cookie.startsWith("__txn_") && cookie.includes("Max-Age=0")));
  }
  assert.equal(opened, 0);
});

test("real SDK callback contains token transport, size and cancellation failures without issuing a session", async () => {
  for (const code of ["header-error", "header-cancel", "stream-error", "late-stream-error", "chunked-overflow", "understated-length", "http-error", "transport-error"]) {
    const { result } = await sdkCallback(code);
    assert.equal(result.status, 400);
    assert.equal(await result.text(), "Authentication is unavailable.");
    assert.equal(result.headers.get("location"), null);
    assert.doesNotMatch(JSON.stringify(Object.fromEntries(result.headers)), /PRIVATE_/);
    assert.ok(!result.headers.getSetCookie().some((cookie) => cookie.startsWith("__session=")));
    assert.ok(result.headers.getSetCookie().some((cookie) => cookie.startsWith("__txn_") && cookie.includes("Max-Age=0")));
  }
  assert.equal(opened, 0);
});

test("callback denies inactive tenants and sanitizes persistence failures while clearing the transaction", async () => {
  for (const inactive of [{ ...member, active: false }, { ...member, tenantActive: false }]) {
    setMembership(inactive);
    const { result } = await sdkCallback("valid");
    assert.equal(result.status, 403);
    assert.equal(result.headers.get("location"), null);
    assert.equal(await result.text(), "Authentication is unavailable.");
  }
  failSql = "select"; failClose = true;
  const { result } = await sdkCallback("valid");
  assert.equal(result.status, 503);
  assert.equal(await result.text(), "Authentication is unavailable.");
  assert.doesNotMatch(JSON.stringify(Object.fromEntries(result.headers)), /PRIVATE_/);
  assert.ok(result.headers.getSetCookie().some((cookie) => cookie.startsWith("__txn_") && cookie.includes("Max-Age=0")));
  assert.equal(opened, closed);
});
