import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { Pool } from "@neondatabase/serverless";
import Home from "../../src/app/page.tsx";
import { loadMonitoringDashboardData } from "../../src/lib/monitoring-data.ts";
import { MonitoringDashboard } from "../../src/components/monitoring-dashboard.tsx";
import { mapObservedConversation, mapPersistedConversation, type MonitoringDashboardData } from "../../src/lib/monitoring.ts";

type Dependencies = NonNullable<Parameters<typeof loadMonitoringDashboardData>[0]>;
type Connection = ReturnType<Dependencies["createDb"]>;
type Viewer = { subject: string; tenantId: string | null } | null;
const privateTitle = "SYNTHETIC_RESTRICTED_TITLE";
const privateReason = "SYNTHETIC_RESTRICTED_REASON";
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

async function configuredPilot(run: () => Promise<void>) {
  const originalTenant = process.env.SIGNAL_DASHBOARD_TENANT_ID;
  const originalDatabase = process.env.DATABASE_URL;
  process.env.SIGNAL_DASHBOARD_TENANT_ID = "tenant-review";
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
}

for (const [name, viewer] of [
  ["no authorization dependency", undefined],
  ["anonymous viewer", null],
  ["unmapped authenticated viewer", { subject: "auth0|synthetic", tenantId: null }],
  ["viewer mapped to a different tenant", { subject: "auth0|synthetic", tenantId: "other-tenant" }],
  ["missing verified subject", { subject: "", tenantId: "tenant-review" }],
  ["blank verified subject", { subject: "   ", tenantId: "tenant-review" }],
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

test("B-A10-04 only an injected verified subject-to-pilot mapping permits private reads", async () => {
  await configuredPilot(async () => {
    const { dependencies, calls } = fixture({ subject: "auth0|synthetic", tenantId: "tenant-review" });
    const data = await loadMonitoringDashboardData(dependencies);
    assert.equal(data.mode, "LIVE");
    assert.deepEqual(calls, ["authorize", "connect", "pilot:tenant-review", "threads:tenant-review", "observers:tenant-review", "close"]);
    assert.equal(data.conversations.length, 2);
    const html = render(data);
    assert.equal(html.includes(privateTitle), true);
    assert.equal(html.includes(privateReason), true);
    assert.equal(JSON.stringify(data).includes("auth0|synthetic"), false);
  });
});

test("B-A10-04 unavailable rendering discards accidentally retained private records", () => {
  const html = render({ mode: "UNAVAILABLE", notice: "Private monitoring is unavailable.", connectors: [], conversations: [mapPersistedConversation(thread), mapObservedConversation(observer)] });
  assertNoPrivateText(html);
});

test("B-A10-04 default real loader and public page never query DB, even with Auth0 env present", async (t) => {
  let queries = 0;
  const noDatabase = () => { queries += 1; throw new Error("synthetic-database-access-forbidden"); };
  t.mock.method(Pool.prototype, "query", noDatabase);
  t.mock.method(Pool.prototype, "connect", noDatabase);
  const names = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"];
  const previous = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = "synthetic-configuration";
  try {
    await configuredPilot(async () => {
      const data = await loadMonitoringDashboardData();
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(data.conversations, []);
      assert.match(data.notice, /viewer authentication is not configured/);
      assertNoPrivateText(JSON.stringify(data));
      const page = await Home();
      assert.deepEqual(page.props.data.conversations, []);
      const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, page));
      assertNoPrivateText(html);
      assert.equal(html.includes("Public setup shell"), true);
      assert.equal(html.includes("viewer authentication is not configured"), true);
      assert.equal(queries, 0);
    });
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("B-A10-04 flat viewer claims and page/header/query tenant hints cannot supply authority", async () => {
  await configuredPilot(async () => {
    const { dependencies, calls } = fixture();
    const claimed = { ...dependencies, subject: "auth0|synthetic", tenantId: "tenant-review", authorized: true, headers: { "x-tenant-id": "tenant-review" }, searchParams: { tenantId: "tenant-review" } };
    const data = await loadMonitoringDashboardData(claimed);
    assert.equal(data.mode, "UNAVAILABLE");
    assert.deepEqual(calls, []);
    const callPage = Home as (...args: unknown[]) => ReturnType<typeof Home>;
    const page = await callPage(claimed);
    assert.equal(page.props.data.mode, "UNAVAILABLE");
    assertNoPrivateText(renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, page)));
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

test("B-A10-04 anonymous, unmapped and mismatched denials disclose no tenant existence", async () => {
  await configuredPilot(async () => {
    const notices: string[] = [];
    for (const viewer of [null, { subject: "auth0|synthetic", tenantId: null }, { subject: "auth0|synthetic", tenantId: "other-tenant" }]) {
      const { dependencies } = fixture(viewer);
      const data = await loadMonitoringDashboardData(dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      notices.push(data.notice);
      assert.equal(JSON.stringify(data).includes("other-tenant"), false);
    }
    assert.equal(new Set(notices).size, 1);
  });
});
