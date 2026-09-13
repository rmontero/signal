import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, mock } from "node:test";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import type { SignalDb } from "../../src/db/client.ts";
import type { Membership, ViewerTenantDependencies } from "../../src/lib/tenant-context.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { createViewerTenantResolver, resolveViewerTenant } = await import("../../src/lib/tenant-context.ts");
const { normalizeAuth0Subject, getVerifiedAuth0Subject } = await import("../../src/lib/auth0.ts");
const member: Membership = { subject: "auth0|User-123", tenantId: "tenant-a", role: "MEMBER", active: true, tenantActive: true };

function fixture(session: unknown = { user: { sub: member.subject } }, membership: unknown = member) {
  const calls: string[] = [];
  const db = {} as SignalDb;
  const dependencies: ViewerTenantDependencies = {
    getSession: async () => { calls.push("session"); return session; },
    createDb: () => { calls.push("connect"); return { db, pool: { end: async () => { calls.push("close"); } } }; },
    findMembershipBySubject: async (seenDb, subject) => {
      assert.equal(seenDb, db);
      calls.push(`lookup:${subject}`);
      return membership as Membership | null;
    },
  };
  return { dependencies, calls };
}

test("subject normalization trims outer spaces and preserves opaque identity and case", () => {
  assert.equal(normalizeAuth0Subject("  auth0|User-123  "), "auth0|User-123");
  assert.equal(normalizeAuth0Subject("google-oauth2|123"), "google-oauth2|123");
  assert.equal(normalizeAuth0Subject("opaque-subject"), "opaque-subject");
  for (const subject of [null, undefined, 1, {}, "", "   ", "auth0|two words", "auth0|line\nbreak", "\tauth0|id", "auth0|id\r", "auth0|\u007f", "auth0|é", "a".repeat(256)]) {
    assert.equal(normalizeAuth0Subject(subject), null);
  }
});

test("unauthenticated and malformed sessions never open the membership database", async () => {
  for (const session of [null, {}, { user: null }, { user: {} }, { user: { sub: "" } }, { user: { sub: 1 } }, { user: { sub: "auth0|line\nbreak" } }]) {
    const { dependencies, calls } = fixture(session);
    assert.equal(await createViewerTenantResolver(dependencies)(), null);
    assert.deepEqual(calls, ["session"]);
  }
});

test("resolver queries by the verified normalized subject and returns only tenant authority", async () => {
  for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
    const { dependencies, calls } = fixture({ user: { sub: "  auth0|User-123  " } }, { ...member, role, privateData: "do-not-serialize" });
    assert.deepEqual(await createViewerTenantResolver(dependencies)(), { subject: member.subject, tenantId: "tenant-a", role });
    assert.deepEqual(calls, ["session", "connect", `lookup:${member.subject}`, "close"]);
  }
});

test("missing, inactive, malformed, ambiguous and cross-subject memberships fail closed", async () => {
  for (const membership of [
    null, {}, [member], [member, { ...member, tenantId: "tenant-b" }],
    { ...member, active: false }, { ...member, active: "true" },
    { ...member, tenantActive: false }, { ...member, tenantActive: undefined },
    { ...member, role: "SUPERADMIN" }, { ...member, tenantId: "" },
    { ...member, tenantId: " tenant-a" }, { ...member, tenantId: "tenant\na" },
    { ...member, subject: "auth0|Other-user", tenantId: "tenant-b" },
    { ...member, subject: "auth0|user-123" }, { ...member, subject: " auth0|User-123" },
  ]) {
    const { dependencies, calls } = fixture(undefined, membership);
    assert.equal(await createViewerTenantResolver(dependencies)(), null);
    assert.equal(calls.at(-1), "close");
  }
});

test("browser-like tenant claims and the legacy env selector cannot select a tenant", async () => {
  const previous = process.env.SIGNAL_DASHBOARD_TENANT_ID;
  process.env.SIGNAL_DASHBOARD_TENANT_ID = "attacker-tenant";
  try {
    const { dependencies } = fixture({ user: { sub: member.subject, tenantId: "attacker-tenant", role: "OWNER" }, tenantId: "attacker-tenant" });
    const resolve = createViewerTenantResolver(dependencies);
    assert.equal(resolve.length, 0);
    assert.deepEqual(await resolve(), { subject: member.subject, tenantId: "tenant-a", role: "MEMBER" });
  } finally {
    if (previous === undefined) delete process.env.SIGNAL_DASHBOARD_TENANT_ID;
    else process.env.SIGNAL_DASHBOARD_TENANT_ID = previous;
  }
});

test("session, database and repository failures return null without leaking errors", async () => {
  for (const failure of ["getSession", "createDb", "findMembershipBySubject"] as const) {
    const { dependencies, calls } = fixture();
    dependencies[failure] = (() => { throw new Error("private-error-detail"); }) as never;
    assert.equal(await createViewerTenantResolver(dependencies)(), null);
    if (failure === "findMembershipBySubject") assert.equal(calls.at(-1), "close");
  }
  const { dependencies } = fixture(undefined, null);
  dependencies.createDb = () => ({ db: {} as SignalDb, pool: { end: async () => { throw new Error("private-cleanup-error"); } } });
  assert.equal(await createViewerTenantResolver(dependencies)(), null);
});

test("absent Task 2 repository fails closed before constructing a database connection", async () => {
  const { dependencies, calls } = fixture();
  delete dependencies.findMembershipBySubject;
  assert.equal(await createViewerTenantResolver(dependencies)(), null);
  assert.equal(calls.includes("connect"), false);
});

test("production session helpers use the Auth0 server session and default resolver denies until Task 2", async () => {
  const settings = { AUTH0_SECRET: "b".repeat(64), AUTH0_BASE_URL: "https://signal.example", AUTH0_ISSUER_BASE_URL: "https://tenant.example.auth0.com", AUTH0_CLIENT_ID: "fixture", AUTH0_CLIENT_SECRET: "fixture" };
  const previous = { ...process.env };
  Object.assign(process.env, settings);
  const session: SessionData = { user: { sub: member.subject }, tokenSet: { accessToken: "fixture", expiresAt: 1 }, internal: { sid: "fixture", createdAt: 1 } };
  const getSession = mock.method(Auth0Client.prototype, "getSession", async () => session);
  try {
    assert.equal(await getVerifiedAuth0Subject(), member.subject);
    assert.equal(await resolveViewerTenant(), null);
    assert.ok(getSession.mock.calls.every((call) => call.arguments.length === 0));
    getSession.mock.mockImplementation(async () => { throw new Error("private-session-error"); });
    assert.equal(await getVerifiedAuth0Subject(), null);
    assert.equal(await resolveViewerTenant(), null);
  } finally {
    mock.restoreAll();
    for (const key of Object.keys(settings)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
