import assert from "node:assert/strict";
import test from "node:test";

import {
  filterConversations,
  getMonitoringMetrics,
  type MonitoredConversation,
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
  });
});
