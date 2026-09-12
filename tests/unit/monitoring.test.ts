import assert from "node:assert/strict";
import test from "node:test";

import {
  filterConversations,
  getMonitoringMetrics,
  mapPersistedConversation,
  mapObservedConversation,
  type MonitoredConversation,
  type PersistedConversationRow,
} from "../../src/lib/monitoring.ts";

const conversations: MonitoredConversation[] = [
  {
    id: "slack-release",
    source: "slack",
    status: "needs-human",
    priority: "high",
    title: "Release readiness / approval path",
    summary: "The release is green, but the final approver is unclear.",
    workspace: "Talacha",
    location: "#product-release",
    participants: ["Maya", "Alex"],
    lastActivity: "12 min ago",
    activityTimestamp: "2026-09-12T16:48:00.000Z",
    signalLabel: "Decision gap",
    decisionQuestion: "Who owns the final go / no-go call?",
    evidence: [],
    activity: [],
  },
  {
    id: "github-retry",
    source: "github",
    status: "monitoring",
    priority: "medium",
    title: "PR #184 · Retry semantics",
    summary: "The retry policy is being clarified in review.",
    workspace: "signal",
    location: "pull/184",
    participants: ["Rob"],
    lastActivity: "28 min ago",
    activityTimestamp: "2026-09-12T16:32:00.000Z",
    signalLabel: "Technical signal",
    decisionQuestion: null,
    evidence: [],
    activity: [],
  },
];

test("filters conversations by human attention and search text", () => {
  assert.deepEqual(
    filterConversations(conversations, "needs-human", "approval").map(({ id }) => id),
    ["slack-release"],
  );
  assert.deepEqual(
    filterConversations(conversations, "github", "").map(({ id }) => id),
    ["github-retry"],
  );
});

test("computes open, attention, source, and signal metrics", () => {
  assert.deepEqual(getMonitoringMetrics(conversations), {
    open: 2,
    needsHuman: 1,
    slack: 1,
    github: 1,
    noiseFiltered: 0,
  });
});

test("maps a persisted tenant-scoped proposal into a real dashboard conversation", () => {
  const row: PersistedConversationRow = {
    tenantId: "tenant-1",
    threadId: "thread-1",
    channelId: "C123",
    threadTs: "1710000000.000001",
    repositoryOwner: "signal-test",
    repositoryName: "fixtures",
    threadCreatedAt: new Date("2026-09-12T16:00:00.000Z"),
    proposalId: "proposal-1",
    proposalState: "PENDING",
    proposalVersion: 1,
    proposalMutation: { kind: "CREATE_ISSUE", title: "Persist the fixture" },
    operationState: "READY",
    operationCreatedAt: new Date("2026-09-12T16:02:00.000Z"),
  };

  assert.deepEqual(mapPersistedConversation(row), {
    id: "tenant-1:thread-1",
    source: "slack",
    status: "needs-human",
    priority: "high",
    title: "Persist the fixture",
    summary: "A persisted issue proposal is waiting for named Slack approval.",
    workspace: "signal-test/fixtures",
    location: "#C123",
    participants: ["Slack thread"],
    lastActivity: "Sep 12, 2026",
    activityTimestamp: "2026-09-12T16:02:00.000Z",
    signalLabel: "Decision gap",
    decisionQuestion: "Can a named Slack approver review this proposal?",
    evidence: [
      { source: "slack", label: "Slack thread", detail: "Thread 1710000000.000001", href: null },
    ],
    activity: [
      { source: "slack", label: "Proposal persisted", detail: "Awaiting named Slack approval", timestamp: "Sep 12, 2026" },
    ],
    confidence: undefined,
    tags: ["proposal", "approval"],
    signals: ["Proposal version 1 is persisted for review."],
  });
});

test("maps a classified observer event without exposing source payload", () => {
  const conversation = mapObservedConversation({
    tenantId: "tenant-1",
    eventId: "event-1",
    source: "github",
    eventType: "pull_request",
    channelId: null,
    threadTs: null,
    messageTs: null,
    repositoryId: "repo-1",
    repositoryOwner: "rmontero",
    repositoryName: "signal",
    pullRequestNumber: 42,
    classificationState: "SIGNAL",
    classificationReason: "Review risk needs a human decision.",
    createdAt: new Date("2026-09-12T16:00:00.000Z"),
  });
  assert.equal(conversation.source, "github");
  assert.equal(conversation.status, "needs-human");
  assert.equal(conversation.evidence[0]?.href, "https://github.com/rmontero/signal/pull/42");
  assert.equal(JSON.stringify(conversation).includes("source payload"), false);
});
