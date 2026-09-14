import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { MonitoringDashboard } from "../../src/components/monitoring-dashboard.tsx";
import { getConnectorStatuses } from "../../src/lib/dashboard-settings.ts";
import {
  filterConversations, getMonitoringMetrics, mapPersistedConversation, mapObservedConversation,
  type MonitoringDashboardData,
} from "../../src/lib/monitoring.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { loadMonitoringDashboardData } = await import("../../src/lib/monitoring-data.ts");

type ConversationRow = Parameters<typeof mapPersistedConversation>[0];
type ObserverRow = Parameters<typeof mapObservedConversation>[0];
type Dependencies = NonNullable<Parameters<typeof loadMonitoringDashboardData>[0]>;
type Connection = ReturnType<Dependencies["createDb"]>;

const conversationRow: ConversationRow = {
  tenantId: "tenant-fixture", threadId: "thread-1", channelId: "C123", threadTs: "1710000000.000001",
  repositoryOwner: "signal-test", repositoryName: "fixtures",
  threadCreatedAt: new Date("2026-09-12T16:00:00.000Z"),
  proposalId: "proposal-1", proposalState: "PENDING", proposalVersion: 1,
  proposalMutation: { kind: "CREATE_ISSUE", title: "Persist the fixture", body: "synthetic-body-not-for-browser" },
  operationState: "READY", operationCreatedAt: new Date("2026-09-12T16:02:00.000Z"),
};

const observerRow: ObserverRow = {
  tenantId: "tenant-fixture", eventId: "event-1", source: "github", eventType: "pull_request",
  channelId: null, threadTs: null, messageTs: null, repositoryId: "repo-1",
  repositoryOwner: "signal-test", repositoryName: "fixtures", pullRequestNumber: 42,
  classificationState: "PENDING", classificationReason: null,
  createdAt: new Date("2026-09-12T17:00:00.000Z"),
};

function fakeDependencies(overrides: Partial<Dependencies> = {}) {
  let closed = 0;
  const calls: string[] = [];
  const dependencies: Dependencies = {
    resolveViewer: async () => ({ subject: "auth0|synthetic", tenantId: "tenant-fixture" }),
    createDb: () => ({ db: {} as Connection["db"], pool: { end: async () => { closed += 1; } } as Connection["pool"] }),
    loadConfiguredPilot: async (_db, tenantId) => {
      calls.push("pilot:" + tenantId);
      return [{ channelId: "C123", repositoryId: "repo-1", repositoryOwner: "signal-test", repositoryName: "fixtures" }];
    },
    listMonitoringConversations: async (_db, tenantId) => { calls.push("threads:" + tenantId); return [conversationRow]; },
    listObservedConversations: async (_db, tenantId) => { calls.push("observers:" + tenantId); return [observerRow]; },
    ...overrides,
  };
  return { dependencies, calls, closed: () => closed };
}

async function withServerEnvironment(env: { tenant?: string; database?: string }, run: () => Promise<void>) {
  const originalTenant = process.env.SIGNAL_DASHBOARD_TENANT_ID;
  const originalDatabase = process.env.DATABASE_URL;
  if (env.tenant === undefined) delete process.env.SIGNAL_DASHBOARD_TENANT_ID;
  else process.env.SIGNAL_DASHBOARD_TENANT_ID = env.tenant;
  if (env.database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = env.database;
  try { await run(); } finally {
    if (originalTenant === undefined) delete process.env.SIGNAL_DASHBOARD_TENANT_ID;
    else process.env.SIGNAL_DASHBOARD_TENANT_ID = originalTenant;
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
  }
}

test("filters records by attention, source and case-insensitive search", () => {
  const conversations = [mapPersistedConversation(conversationRow), mapObservedConversation(observerRow)];
  assert.deepEqual(filterConversations(conversations, "needs-human", "  FIXTURE  ").map(({ id }) => id), ["thread:thread-1"]);
  assert.deepEqual(filterConversations(conversations, "github").map(({ id }) => id), ["observer:event-1"]);
  assert.deepEqual(filterConversations(conversations, "all", "not-present"), []);
});

test("counts persisted outcomes without inventing noise or hiding blockers", () => {
  const conversations = [mapPersistedConversation(conversationRow), mapObservedConversation({ ...observerRow, classificationState: "BLOCKED" }), mapObservedConversation({ ...observerRow, eventId: "noise", classificationState: "NOISE" })];
  assert.deepEqual(getMonitoringMetrics(conversations), { open: 2, needsHuman: 2, slack: 1, github: 2, noiseFiltered: 1 });
  assert.equal(filterConversations(conversations, "open").length, 2);
  assert.equal(filterConversations(conversations, "all").length, 3);
});

test("maps metadata without payload bodies, tenant identifiers or invented participants", () => {
  const conversation = mapPersistedConversation(conversationRow);
  assert.equal(conversation.status, "needs-human");
  assert.equal(conversation.signalLabel, "Pending Slack review");
  assert.equal(conversation.title, "Persist the fixture");
  assert.match(conversation.summary, /Slack checks .*expiry/);
  assert.deepEqual(conversation.participants, []);
  assert.equal(conversation.confidence, undefined);
  assert.equal(conversation.evidence[0]?.href, "https://slack.com/archives/C123/p1710000000000001");
  assert.equal(JSON.stringify(conversation).includes("synthetic-body-not-for-browser"), false);
  assert.equal(JSON.stringify(conversation).includes(conversationRow.tenantId), false);
  assert.match(conversation.lastActivity, /04:02 PM UTC/);
  assert.match(conversation.activity[0].label, /record created/);
  assert.match(conversation.activity[0].detail, /State-change time is not available/);
});

test("progress comments are described as progress comments instead of issue proposals", () => {
  const conversation = mapPersistedConversation({ ...conversationRow, proposalMutation: { kind: "ADD_PROGRESS_COMMENT", body: "synthetic-comment" } });
  assert.match(conversation.summary, /progress comment/);
  assert.equal(JSON.stringify(conversation).includes("synthetic-comment"), false);
});

test("operation failures, uncertainty, stale approvals and in-flight writes remain truthful", async (t) => {
  for (const [operationState, status, label] of [
    ["UNKNOWN", "needs-human", "Reconciliation needed"],
    ["FAILED", "needs-human", "Action failed"],
    ["STALE", "needs-human", "Fresh review required"],
    ["SENDING", "monitoring", "Action in progress"],
    ["SUCCEEDED", "resolved", "Action succeeded"],
    ["READY", "monitoring", "Approved · awaiting result"],
    ["UNRECOGNIZED", "needs-human", "State unavailable"],
  ]) await t.test(operationState, () => {
    const conversation = mapPersistedConversation({ ...conversationRow, proposalState: "APPROVED", operationState });
    assert.equal(conversation.status, status);
    assert.equal(conversation.signalLabel, label);
    assert.doesNotMatch(conversation.summary, /Signal is monitoring/);
  });
  const uncertain = mapPersistedConversation({ ...conversationRow, proposalState: "EXPIRED", operationState: "UNKNOWN" });
  assert.equal(uncertain.status, "needs-human");
  assert.match(uncertain.summary, /do not retry or create a replacement/);
});

test("expired, dismissed and superseded proposals do not imply successful GitHub actions", () => {
  for (const proposalState of ["EXPIRED", "DISMISSED", "SUPERSEDED"]) {
    const conversation = mapPersistedConversation({ ...conversationRow, proposalState, operationState: "STALE" });
    assert.equal(conversation.status, "resolved");
    assert.match(conversation.signalLabel, new RegExp(proposalState, "i"));
    assert.doesNotMatch(conversation.summary, /recorded as successful|Signal is monitoring/);
  }
});

test("pending expiry uses supplied expiry, never operation creation time", () => {
  const expired = mapPersistedConversation({ ...conversationRow, proposalExpiresAt: new Date("2000-01-01T00:00:00Z") });
  assert.equal(expired.signalLabel, "Proposal expired");
  assert.equal(expired.status, "resolved");
  const current = mapPersistedConversation({ ...conversationRow, proposalExpiresAt: new Date("2100-01-01T00:00:00Z"), operationCreatedAt: new Date("2000-01-01T00:00:00Z") });
  assert.equal(current.signalLabel, "Pending Slack review");
  assert.equal(mapPersistedConversation(conversationRow).signalLabel, "Pending Slack review");
});

test("a thread without a proposal does not claim completed analysis or active monitoring", () => {
  const conversation = mapPersistedConversation({ ...conversationRow, proposalId: null, proposalState: null, proposalMutation: null, operationState: null, operationCreatedAt: null });
  assert.equal(conversation.signalLabel, "Awaiting analysis");
  assert.match(conversation.summary, /no proposal or completed analysis/);
});

test("observer states distinguish pending, blocked, failed and complete classification", async (t) => {
  for (const [classificationState, executionState, status, signalLabel] of [
    ["PENDING", undefined, "monitoring", "Classification pending"],
    ["PENDING", "READY", "monitoring", "Classification pending"],
    ["PENDING", "RUNNING", "monitoring", "Classification in progress"],
    ["PENDING", "BLOCKED", "needs-human", "Classification blocked"],
    ["PENDING", "FAILED", "needs-human", "Classification failed"],
    ["PENDING", "SUCCEEDED", "needs-human", "Classification unavailable"],
    ["BLOCKED", undefined, "needs-human", "Classification blocked"],
    ["NOISE", "SUCCEEDED", "resolved", "Noise filtered"],
    ["SIGNAL", "SUCCEEDED", "needs-human", "Meaningful signal"],
  ] as const) await t.test(classificationState + "/" + (executionState ?? "unavailable"), () => {
    const conversation = mapObservedConversation({ ...observerRow, classificationState, executionState });
    assert.equal(conversation.status, status);
    assert.equal(conversation.signalLabel, signalLabel);
    assert.equal(conversation.activity[0].label, "Observer event received");
  });
});

test("observer evidence links use valid persisted coordinates only", () => {
  const conversation = mapObservedConversation({ ...observerRow, classificationState: "SIGNAL", classificationReason: "Synthetic review risk" });
  assert.equal(conversation.summary, "Synthetic review risk");
  assert.equal(conversation.evidence[0]?.href, "https://github.com/signal-test/fixtures/pull/42");
  assert.equal(mapObservedConversation({ ...observerRow, repositoryOwner: "github.com/../../outside" }).evidence[0]?.href, null);
  assert.equal(mapObservedConversation({ ...observerRow, pullRequestNumber: -1 }).evidence[0]?.href, null);
  assert.equal(mapObservedConversation({ ...observerRow, source: "slack", channelId: "C123/../../outside", messageTs: "1710000000.000001" }).evidence[0]?.href, null);
  assert.equal(mapObservedConversation({ ...observerRow, source: "slack", channelId: "C123", messageTs: "1710000000.000001" }).evidence[0]?.href, "https://slack.com/archives/C123/p1710000000000001");
});

test("missing database fails closed even for an authenticated member", async () => {
  for (const env of [{}, { tenant: "tenant-fixture" }, { tenant: "tenant-fixture", database: "   " }]) {
    await withServerEnvironment(env, async () => {
      const fixture = fakeDependencies({ createDb: () => { assert.fail("database must not be created"); } });
      const data = await loadMonitoringDashboardData(fixture.dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(data.conversations, []);
      assert.deepEqual(fixture.calls, []);
    });
  }
});

test("missing/inactive tenants and tenants without enabled mappings expose no monitoring data", async () => {
  await withServerEnvironment({ tenant: "tenant-fixture", database: "synthetic-url" }, async () => {
    for (const mappings of [null, []]) {
      const fixture = fakeDependencies({ loadConfiguredPilot: async () => mappings, listMonitoringConversations: async () => { assert.fail("inactive or unmapped pilot must not load records"); }, listObservedConversations: async () => { assert.fail("inactive or unmapped pilot must not load observations"); } });
      const data = await loadMonitoringDashboardData(fixture.dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(data.conversations, []);
      assert.equal(fixture.closed(), 1);
    }
  });
});

test("loader uses only the resolved membership tenant and orders records without disclosing identity", async () => {
  await withServerEnvironment({ tenant: "  other-tenant  ", database: "synthetic-url" }, async () => {
    const fixture = fakeDependencies();
    const data = await loadMonitoringDashboardData(fixture.dependencies);
    assert.deepEqual(fixture.calls, ["pilot:tenant-fixture", "threads:tenant-fixture", "observers:tenant-fixture"]);
    assert.equal(data.mode, "LIVE");
    assert.deepEqual(data.conversations.map(({ id }) => id), ["observer:event-1", "thread:thread-1"]);
    assert.ok(data.loadedAt && Number.isFinite(Date.parse(data.loadedAt)));
    assert.match(data.notice, /does not verify current feed health/);
    assert.equal(JSON.stringify(data).includes("tenant-fixture"), false);
    assert.equal(fixture.closed(), 1);
  });
});

test("cross-tenant data aborts the entire snapshot instead of leaking records", async () => {
  await withServerEnvironment({ tenant: "tenant-fixture", database: "synthetic-url" }, async () => {
    for (const overrides of [
      { listObservedConversations: async () => [{ ...observerRow, tenantId: "other-tenant" }] },
      { listMonitoringConversations: async () => [{ ...conversationRow, tenantId: "other-tenant" }] },
    ]) {
      const fixture = fakeDependencies(overrides);
      const data = await loadMonitoringDashboardData(fixture.dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(data.conversations, []);
      assert.doesNotMatch(JSON.stringify(data), /other-tenant|tenant-fixture|Persist the fixture/);
      assert.doesNotMatch(renderDashboard(data), /other-tenant|tenant-fixture|Persist the fixture/);
      assert.equal(fixture.closed(), 1);
    }
  });
});

test("records for removed channels or changed repositories are excluded", async () => {
  await withServerEnvironment({ tenant: "tenant-fixture", database: "synthetic-url" }, async () => {
    const fixture = fakeDependencies({
      listMonitoringConversations: async () => [{ ...conversationRow, channelId: "CREMOVED" }, { ...conversationRow, repositoryName: "replaced" }],
      listObservedConversations: async () => [{ ...observerRow, source: "slack", channelId: "CREMOVED" }, { ...observerRow, repositoryId: "other-repo" }, { ...observerRow, repositoryName: "renamed" }],
    });
    const data = await loadMonitoringDashboardData(fixture.dependencies);
    assert.equal(data.mode, "LIVE");
    assert.deepEqual(data.conversations, []);
    assert.match(data.notice, /no monitoring records/);
    assert.match(data.notice, /not verified by this empty snapshot/);
  });
});

test("database creation, query and cleanup failures never expose errors or produce sample data", async () => {
  await withServerEnvironment({ tenant: "tenant-fixture", database: "synthetic-url" }, async () => {
    const failure = () => { throw new Error("synthetic-private-error"); };
    for (const overrides of [{ createDb: failure }, { listObservedConversations: failure }, { loadConfiguredPilot: failure }]) {
      const fixture = fakeDependencies(overrides);
      const data = await loadMonitoringDashboardData(fixture.dependencies);
      assert.equal(data.mode, "UNAVAILABLE");
      assert.deepEqual(data.conversations, []);
      assert.equal(JSON.stringify(data).includes("synthetic-private-error"), false);
    }
    const fixture = fakeDependencies();
    const data = await loadMonitoringDashboardData({ ...fixture.dependencies, createDb: () => ({ ...fixture.dependencies.createDb(), pool: { end: async (): Promise<void> => { failure(); } } as Connection["pool"] }) });
    assert.equal(data.mode, "LIVE");
  });
});

function renderDashboard(data: MonitoringDashboardData) {
  const router = { bfcacheId: "synthetic", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, createElement(MonitoringDashboard, { data })));
}

test("unavailable UI does not render fake identity, active feeds, zero success metrics or model claims", () => {
  const html = renderDashboard({ mode: "UNAVAILABLE", notice: "Synthetic unavailable notice", conversations: [], connectors: getConnectorStatuses({}) });
  assert.match(html, /Monitoring data is unavailable/);
  assert.match(html, /Sources represented<\/span><strong>—<\/strong>/);
  assert.match(html, /Refresh records/);
  assert.match(html, /aria-label="Setup help"/);
  assert.match(html, /aria-label="Open settings"/);
  assert.doesNotMatch(html, /Neon connected|>Rob<|Luna 5\.6|Ask squad|Open profile|>Live data</);
  assert.doesNotMatch(html, /class="nav-count|>0 showing<|>0 in this snapshot<|>0 events</);
});

test("unavailable UI discards stale records, counts and snapshot time after access denial", () => {
  const html = renderDashboard({
    mode: "UNAVAILABLE", notice: "Private monitoring is unavailable.", loadedAt: "2030-01-01T00:00:00.000Z",
    conversations: [mapPersistedConversation(conversationRow), mapObservedConversation(observerRow)],
    connectors: getConnectorStatuses({}),
  });
  assert.doesNotMatch(html, /Persist the fixture|synthetic-body-not-for-browser|tenant-fixture|2030-01-01|class="nav-count/);
  assert.match(html, /Sources represented<\/span><strong>—<\/strong>/);
  assert.match(html, /No current snapshot/);
});

test("legacy operator setup readiness grants neither dashboard membership nor provider access", async () => {
  const connectors = getConnectorStatuses({ DATABASE_URL: "synthetic-url", SIGNAL_DASHBOARD_TENANT_ID: "legacy-tenant" });
  const neon = connectors.find(({ id }) => id === "neon")!;
  const auth = connectors.find(({ id }) => id === "auth0")!;
  assert.equal(neon.status, "ready");
  assert.match(neon.detail, /legacy.*operator.*pilot/i);
  assert.match(auth.detail, /active tenant membership/i);
  assert.match(auth.detail, /signing in does not connect.*providers/i);
  assert.doesNotMatch(JSON.stringify(connectors), /synthetic-url|legacy-tenant/);

  await withServerEnvironment({ tenant: "legacy-tenant", database: "synthetic-url" }, async () => {
    const fixture = fakeDependencies({ resolveViewer: async () => null, createDb: () => { assert.fail("configuration cannot grant membership"); } });
    const data = await loadMonitoringDashboardData(fixture.dependencies);
    assert.equal(data.mode, "UNAVAILABLE");
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(data.conversations, []);
  });
});

test("rendered records show exact states and keep dashboard approval unavailable", () => {
  const html = renderDashboard({ mode: "LIVE", loadedAt: "2026-09-12T18:00:00.000Z", notice: "Synthetic persisted snapshot", conversations: [mapPersistedConversation({ ...conversationRow, operationState: "FAILED" }), mapObservedConversation(observerRow)], connectors: getConnectorStatuses({}) });
  assert.match(html, /Action failed/);
  assert.match(html, /Classification pending/);
  assert.match(html, /cannot send requests or approve actions/);
  assert.match(html, /Snapshot 2026-09-12 18:00:00 UTC/);
  assert.match(html, /Sources represented<\/span><strong>2<\/strong>/);
  assert.doesNotMatch(html, /Neon connected|Ask squad|Signal is monitoring/);
});
