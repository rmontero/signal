import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { SessionData } from "@auth0/nextjs-auth0/types";
import { Pool } from "@neondatabase/serverless";
import { MonitoringDashboard } from "../../src/components/monitoring-dashboard.tsx";
import { mapObservedConversation, mapPersistedConversation, type MonitoringDashboardData } from "../../src/lib/monitoring.ts";
import type { Membership } from "../../src/lib/tenant-context.ts";

// Next supplies this marker at build time. Keep the real resolver and DAL in
// these Node tests; only the session and database transports are replaced.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { default: Home } = await import("../../src/app/page.tsx");
const { loadMonitoringDashboardData } = await import("../../src/lib/monitoring-data.ts");

type Dependencies = NonNullable<Parameters<typeof loadMonitoringDashboardData>[0]>;
type Connection = ReturnType<Dependencies["createDb"]>;
type Viewer = { subject: string; tenantId: string | null } | null;
const privateTitle = "SYNTHETIC_RESTRICTED_TITLE";
const privateReason = "SYNTHETIC_RESTRICTED_REASON";
const member: Membership = { subject: "auth0|synthetic", tenantId: "tenant-review", role: "MEMBER", active: true, tenantActive: true };
const router = { bfcacheId: "synthetic", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const thread = {
  tenantId: "tenant-review", threadId: "thread-review", channelId: "C1", threadTs: "1710000000.000001",
  threadCreatedAt: new Date("2030-01-01T00:00:00.000Z"), operationCreatedAt: null,
  repositoryOwner: "acme", repositoryName: "signal", proposalId: "proposal-review", proposalVersion: 1,
  proposalState: "PENDING", proposalMutation: { kind: "CREATE_ISSUE", title: privateTitle }, operationState: "READY",
};
const observer = {
  tenantId: "tenant-review", eventId: "event-review", source: "github" as const, eventType: "pull_request.opened",
  channelId: null, threadTs: null, messageTs: null, repositoryId: "1", repositoryOwner: "acme", repositoryName: "signal",
  pullRequestNumber: 7, classificationState: "SIGNAL" as const, classificationReason: privateReason,
  createdAt: new Date("2030-01-01T00:01:00.000Z"),
};

function fixture(viewer?: Viewer | (() => Promise<Viewer>)) {
  const calls: string[] = [];
  const dependencies: Dependencies & { resolveViewer?: () => Promise<Viewer> } = {
    createDb: () => { calls.push("connect"); return { db: {} as Connection["db"], pool: { end: async () => { calls.push("close"); } } as Connection["pool"] }; },
    loadConfiguredPilot: async (_db, tenantId) => { calls.push("pilot:" + tenantId); return [{ channelId: "C1", repositoryId: "1", repositoryOwner: "acme", repositoryName: "signal" }]; },
    listMonitoringConversations: async (_db, tenantId) => { calls.push("threads:" + tenantId); return [thread]; },
    listObservedConversations: async (_db, tenantId) => { calls.push("observers:" + tenantId); return [observer]; },
    ...(viewer === undefined ? {} : { resolveViewer: async () => { calls.push("authorize"); return typeof viewer === "function" ? viewer() : viewer; } }),
  };
  return { dependencies, calls };
}

async function configuredPilot(run: () => Promise<void>, legacyTenant: string | null = "tenant-review") {
  const originalTenant = process.env.SIGNAL_DASHBOARD_TENANT_ID;
  const originalDatabase = process.env.DATABASE_URL;
  if (legacyTenant === null) delete process.env.SIGNAL_DASHBOARD_TENANT_ID;
  else process.env.SIGNAL_DASHBOARD_TENANT_ID = legacyTenant;
  process.env.DATABASE_URL = "synthetic-not-a-connection";
  try { await run(); } finally {
    if (originalTenant === undefined) delete process.env.SIGNAL_DASHBOARD_TENANT_ID;
    else process.env.SIGNAL_DASHBOARD_TENANT_ID = originalTenant;
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
  }
}

function render(data: MonitoringDashboardData) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, createElement(MonitoringDashboard, { data })));
}

function assertNoPrivateText(text: string) {
  assert.equal(text.includes(privateTitle), false, "restricted proposal text must not be exposed");
  assert.equal(text.includes(privateReason), false, "restricted classification text must not be exposed");
  assert.doesNotMatch(text, /tenant-review|other-tenant|auth0\|synthetic|private-session-token|private-user@example/);
}

function defaultRuntime(t: TestContext, memberships: Membership[] = [member], authenticated = true) {
  const settings = {
    AUTH0_SECRET: "c".repeat(64), AUTH0_BASE_URL: "https://signal.example",
    AUTH0_ISSUER_BASE_URL: "https://task3.example.auth0.com", AUTH0_CLIENT_ID: "fixture", AUTH0_CLIENT_SECRET: "fixture",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const name of Object.keys(settings)) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let closed = 0;
  let providerCalls = 0;
  const session = {
    user: { sub: member.subject, email: "private-user@example", tenantId: "other-tenant", role: "OWNER" },
    tokenSet: { accessToken: "private-session-token", expiresAt: 1 }, internal: { sid: "fixture", createdAt: 1 },
    tenantId: "other-tenant",
  } as SessionData;
  const getSession = t.mock.method(Auth0Client.prototype, "getSession", async () => authenticated ? session : null);
  t.mock.method(globalThis, "fetch", async () => { providerCalls += 1; throw new Error("provider access forbidden"); });
  t.mock.method(Pool.prototype, "connect", () => { throw new Error("database transport forbidden"); });
  t.mock.method(Pool.prototype, "end", async () => { closed += 1; });
  t.mock.method(Pool.prototype, "query", async (query: { text: string }, values: unknown[] = []) => {
    queries.push({ text: query.text, values });
    const table = query.text.match(/\bfrom "([^"]+)"/)?.[1];
    if (table === "tenant_memberships") {
      return { rows: memberships.map((row) => [row.subject, row.tenantId, row.role, row.active, row.tenantActive]) };
    }
    if (table === "tenants") return { rows: [[member.tenantId]] };
    if (table === "channel_mappings") return { rows: [["C1", "1", "acme", "signal"]] };
    if (table === "threads") return { rows: [[
      thread.tenantId, thread.threadId, thread.channelId, thread.threadTs, thread.repositoryOwner, thread.repositoryName,
      thread.threadCreatedAt.toISOString(), thread.proposalId, thread.proposalState, thread.proposalVersion, null,
      thread.proposalMutation, thread.operationState, null,
    ]] };
    if (table === "observed_events") return { rows: [[
      observer.tenantId, observer.eventId, observer.source, observer.eventType, null, null, null,
      observer.repositoryId, observer.repositoryOwner, observer.repositoryName, observer.pullRequestNumber,
      observer.classificationState, observer.classificationReason, "SUCCEEDED", observer.createdAt.toISOString(),
    ]] };
    throw new Error("unexpected synthetic query");
  });
  return { queries, getSession, closed: () => closed, providerCalls: () => providerCalls };
}

for (const [name, viewer] of [
  ["no authorization dependency", undefined],
  ["anonymous viewer", null],
  ["unmapped authenticated viewer", { subject: "auth0|synthetic", tenantId: null }],
  ["missing verified subject", { subject: "", tenantId: "tenant-review" }],
  ["blank verified subject", { subject: "   ", tenantId: "tenant-review" }],
  ["empty tenant", { subject: "auth0|synthetic", tenantId: "" }],
  ["malformed tenant", { subject: "auth0|synthetic", tenantId: "tenant\nreview" }],
] as const) {
  test("B-A10-04 rejects " + name + " before DB access or rendering", async () => {
    await configuredPilot(async () => {
      const { dependencies, calls } = fixture(viewer);
      const data = await loadMonitoringDashboardData(dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(data.conversations, []);
      assert.deepEqual(calls, viewer === undefined ? [] : ["authorize"]);
      assertNoPrivateText(JSON.stringify(data));
      assertNoPrivateText(render(data));
    });
  });
}

test("B-A10-04 authorization failure is sanitized and never falls back to the pilot", async () => {
  await configuredPilot(async () => {
    const { dependencies, calls } = fixture(async () => { throw new Error("synthetic-private-session-error"); });
    const data = await loadMonitoringDashboardData(dependencies);
    assert.equal(data.mode, "UNAVAILABLE");
    assert.deepEqual(calls, ["authorize"]);
    assert.equal(JSON.stringify(data).includes("synthetic-private-session-error"), false);
    assertNoPrivateText(render(data));
  });
});

test("verified membership selects the dashboard tenant independently of legacy pilot configuration", async () => {
  for (const legacyTenant of [null, "", "   ", "other-tenant"]) await configuredPilot(async () => {
    const { dependencies, calls } = fixture({ subject: "auth0|synthetic", tenantId: "tenant-review" });
    const data = await loadMonitoringDashboardData(dependencies);
    assert.equal(data.mode, "LIVE");
    assert.deepEqual(calls, ["authorize", "connect", "pilot:tenant-review", "threads:tenant-review", "observers:tenant-review", "close"]);
    assert.equal(data.conversations.length, 2);
    const html = render(data);
    assert.equal(html.includes(privateTitle), true);
    assert.equal(html.includes(privateReason), true);
    assert.equal(JSON.stringify(data).includes("auth0|synthetic"), false);
    assert.equal(JSON.stringify(data).includes("tenant-review"), false);
  }, legacyTenant);
});

test("B-A10-04 unavailable rendering discards accidentally retained private records", () => {
  const html = render({ mode: "UNAVAILABLE", notice: "Private monitoring is unavailable.", connectors: [], conversations: [mapPersistedConversation(thread), mapObservedConversation(observer)] });
  assertNoPrivateText(html);
});

test("default loader and page deny anonymous viewers even with Auth0 and pilot configuration", async (t) => {
  const runtime = defaultRuntime(t, [], false);
  await configuredPilot(async () => {
    const data = await loadMonitoringDashboardData();
    assert.equal(data.mode, "UNAVAILABLE");
    assert.deepEqual(data.conversations, []);
    assert.match(data.notice, /verified server session.*active.*membership/i);
    assertNoPrivateText(JSON.stringify(data));
    const page = await Home();
    assert.deepEqual(page.props.data.conversations, []);
    const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, page));
    assertNoPrivateText(html);
    assert.equal(html.includes("Public setup shell"), true);
    assert.equal(runtime.getSession.mock.callCount(), 2);
    assert.deepEqual(runtime.queries, []);
    assert.equal(runtime.providerCalls(), 0);
  });
});

test("default loader and page use Auth0 membership and tenant-scoped repositories without injected authority", async (t) => {
  const runtime = defaultRuntime(t);
  await configuredPilot(async () => {
    delete process.env.SIGNAL_DASHBOARD_TENANT_ID;
    const data = await loadMonitoringDashboardData();
    assert.equal(data.mode, "LIVE");
    assert.deepEqual(data.conversations.map(({ id }) => id), ["observer:event-review", "thread:thread-review"]);
    assert.match(render(data), new RegExp(privateTitle));
    assert.match(render(data), new RegExp(privateReason));
    assert.doesNotMatch(JSON.stringify(data), /tenant-review|auth0\|synthetic|private-session-token|private-user@example/);

    process.env.SIGNAL_DASHBOARD_TENANT_ID = "other-tenant";
    const page = await (Home as (...args: unknown[]) => ReturnType<typeof Home>)({
      tenantId: "other-tenant", subject: "auth0|unverified", authorized: true,
      headers: new Headers({ "x-tenant-id": "other-tenant", "x-signal-tenant-id": "other-tenant" }),
      searchParams: Promise.resolve({ tenantId: "other-tenant", tenant: "other-tenant" }),
      cookies: { tenantId: "other-tenant" },
    });
    assert.equal(page.props.data.mode, "LIVE");
    assert.deepEqual(page.props.data.conversations, data.conversations);
    assert.equal(runtime.getSession.mock.callCount(), 2);
    assert.ok(runtime.getSession.mock.calls.every((call) => call.arguments.length === 0));
    assert.equal(runtime.queries.filter(({ text }) => text.includes('from "tenant_memberships"')).length, 2);
    for (const query of runtime.queries) {
      if (query.text.includes('from "tenant_memberships"')) assert.deepEqual(query.values, [member.subject, 2]);
      else {
        const scope = query.text.match(/\bwhere \(?"(?:tenants|channel_mappings|threads|observed_events)"\."(?:id|tenant_id)" = \$(\d+)/);
        assert.ok(scope, "every monitoring query must filter by tenant");
        assert.equal(query.values[Number(scope[1]) - 1], member.tenantId);
      }
      assert.equal(query.values.includes("other-tenant"), false);
    }
    assert.equal(runtime.closed(), 4);
    assert.equal(runtime.providerCalls(), 0);
  });
});

for (const [name, memberships] of [
  ["unmapped", []],
  ["inactive membership", [{ ...member, active: false }]],
  ["inactive tenant", [{ ...member, tenantActive: false }]],
  ["cross-subject membership", [{ ...member, subject: "auth0|other", tenantId: "other-tenant" }]],
  ["ambiguous cross-tenant memberships", [member, { ...member, tenantId: "other-tenant" }]],
] as const) {
  test("default loader denies " + name + " before any monitoring query", async (t) => {
    const runtime = defaultRuntime(t, [...memberships]);
    await configuredPilot(async () => {
      const data = await loadMonitoringDashboardData();
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(data.conversations, []);
      assert.equal(runtime.getSession.mock.callCount(), 1);
      assert.equal(runtime.queries.length, 1);
      assert.match(runtime.queries[0].text, /from "tenant_memberships"/);
      assert.equal(runtime.closed(), 1);
      assertNoPrivateText(JSON.stringify(data));
      assertNoPrivateText(render(data));
      assert.equal(runtime.providerCalls(), 0);
    });
  });
}

test("B-A10-04 flat viewer claims and page/header/query tenant hints cannot supply authority", async (t) => {
  const runtime = defaultRuntime(t, [], false);
  await configuredPilot(async () => {
    const { dependencies, calls } = fixture();
    const claimed = { ...dependencies, subject: "auth0|synthetic", tenantId: "tenant-review", authorized: true, headers: { "x-tenant-id": "tenant-review" }, searchParams: { tenantId: "tenant-review" }, cookies: { tenantId: "tenant-review" } };
    const data = await loadMonitoringDashboardData(claimed);
    assert.equal(data.mode, "UNAVAILABLE");
    assert.deepEqual(calls, []);
    const callPage = Home as (...args: unknown[]) => ReturnType<typeof Home>;
    const page = await callPage(claimed);
    assert.equal(page.props.data.mode, "UNAVAILABLE");
    assertNoPrivateText(renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, page)));
    assert.deepEqual(runtime.queries, []);
    assert.equal(runtime.providerCalls(), 0);
  });
});

test("B-A10-04 browser invocation cannot use even an injected viewer resolver", async () => {
  await configuredPilot(async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    try {
      const { dependencies, calls } = fixture({ subject: "auth0|synthetic", tenantId: "tenant-review" });
      const data = await loadMonitoringDashboardData(dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(calls, []);
      assertNoPrivateText(JSON.stringify(data));
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

test("B-A10-04 anonymous and malformed denials disclose no tenant existence", async () => {
  await configuredPilot(async () => {
    const notices: string[] = [];
    for (const viewer of [null, { subject: "auth0|synthetic", tenantId: null }, { subject: "", tenantId: "other-tenant" }]) {
      const { dependencies } = fixture(viewer);
      const data = await loadMonitoringDashboardData(dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      notices.push(data.notice);
      assert.equal(JSON.stringify(data).includes("other-tenant"), false);
    }
    assert.equal(new Set(notices).size, 1);
  });
});
