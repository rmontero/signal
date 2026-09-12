export type ConversationSource = "slack" | "github";
export type ConversationStatus = "needs-human" | "monitoring" | "resolved";
export type ConversationPriority = "high" | "medium" | "low";
export type ConversationFilter = "all" | "open" | "needs-human";
export type SourceFilter = "all" | ConversationSource;

export type EvidenceReference = {
  source: ConversationSource;
  label: string;
  detail: string;
  href: string | null;
};

export type ActivityEntry = {
  source: ConversationSource;
  label: string;
  detail: string;
  timestamp: string;
};

export type MonitoredConversation = {
  id: string;
  source: ConversationSource;
  status: ConversationStatus;
  priority: ConversationPriority;
  title: string;
  summary: string;
  workspace: string;
  location: string;
  participants: string[];
  lastActivity: string;
  activityTimestamp: string;
  signalLabel: string;
  decisionQuestion: string | null;
  evidence: EvidenceReference[];
  activity: ActivityEntry[];
  confidence?: number;
  tags?: string[];
  signals?: string[];
};

export type MonitoringMetrics = {
  open: number;
  needsHuman: number;
  slack: number;
  github: number;
};

export type MonitoringDashboardData = {
  mode: "PREVIEW" | "LIVE";
  conversations: MonitoredConversation[];
};

export const CURRENT_MONITORING_DATA: MonitoringDashboardData = {
  mode: "PREVIEW",
  conversations: [
    {
      id: "release-ownership",
      source: "slack",
      status: "needs-human",
      priority: "high",
      title: "Canary rollout ownership is still open",
      summary: "The rollout is technically ready, but nobody has confirmed the rollback owner or the customer communication window.",
      workspace: "Talacha",
      location: "#product-engineering",
      participants: ["Maya", "Alex", "Priya", "6 people"],
      lastActivity: "8 min ago",
      activityTimestamp: "2026-09-12T16:52:00.000Z",
      signalLabel: "Decision gap",
      decisionQuestion: "Who can confirm the rollback owner and the customer communication window?",
      confidence: 0.82,
      tags: ["release", "ownership"],
      signals: [
        "Deployment checks are green across staging.",
        "The rollback window is referenced by two people but has no named owner.",
        "Customer communication is blocked on that decision.",
      ],
      evidence: [
        { source: "slack", label: "#product-engineering", detail: "12 messages · 8 min ago", href: null },
        { source: "github", label: "PR #842", detail: "payments / rollout", href: null },
      ],
      activity: [
        { source: "slack", label: "Decision gap surfaced", detail: "Rollback owner is still unassigned", timestamp: "8 min ago" },
        { source: "github", label: "PR updated", detail: "Staging checks passed", timestamp: "19 min ago" },
      ],
    },
    {
      id: "search-latency",
      source: "github",
      status: "monitoring",
      priority: "medium",
      title: "Search latency after the cache merge",
      summary: "A performance regression is being investigated with a proposed cache change; the latest benchmark is still pending.",
      workspace: "signal",
      location: "PR #842",
      participants: ["Rob", "Inez", "4 people"],
      lastActivity: "24 min ago",
      activityTimestamp: "2026-09-12T16:36:00.000Z",
      signalLabel: "Technical signal",
      decisionQuestion: null,
      confidence: 0.91,
      tags: ["performance", "cache"],
      signals: [
        "The regression is isolated to one query path.",
        "The proposed change has review approval but no production benchmark.",
      ],
      evidence: [
        { source: "github", label: "PR #842", detail: "6 comments · 24 min ago", href: null },
        { source: "slack", label: "#platform", detail: "3 references · today", href: null },
      ],
      activity: [
        { source: "github", label: "Review discussion", detail: "Benchmark requested before merge", timestamp: "24 min ago" },
      ],
    },
    {
      id: "renewal-rollout",
      source: "slack",
      status: "needs-human",
      priority: "medium",
      title: "Enterprise renewal rollout needs a decision",
      summary: "The squad agrees on the rollout sequence but is split on whether support coverage is sufficient for the first wave.",
      workspace: "Talacha",
      location: "#customer-ops",
      participants: ["Dana", "Leo", "8 people"],
      lastActivity: "42 min ago",
      activityTimestamp: "2026-09-12T16:18:00.000Z",
      signalLabel: "Capacity question",
      decisionQuestion: "Should the first wave stay at ten accounts, or should support coverage be expanded first?",
      confidence: 0.76,
      tags: ["customer", "capacity"],
      signals: [
        "Product and sales are aligned on the first-wave account list.",
        "Support has one unresolved capacity concern.",
      ],
      evidence: [
        { source: "slack", label: "#customer-ops", detail: "18 messages · 42 min ago", href: null },
      ],
      activity: [
        { source: "slack", label: "Human input suggested", detail: "Support coverage remains unresolved", timestamp: "42 min ago" },
      ],
    },
    {
      id: "auth-cleanup",
      source: "github",
      status: "resolved",
      priority: "low",
      title: "Auth callback cleanup is moving through review",
      summary: "The agent found no unresolved decision, owner gap, or material risk in the latest review discussion.",
      workspace: "signal",
      location: "PR #157",
      participants: ["Maya", "3 people"],
      lastActivity: "1 hr ago",
      activityTimestamp: "2026-09-12T15:58:00.000Z",
      signalLabel: "No action needed",
      decisionQuestion: null,
      confidence: 0.97,
      tags: ["auth", "cleanup"],
      signals: ["Review comments are resolved and the deployment owner is named."],
      evidence: [
        { source: "github", label: "PR #157", detail: "4 comments · 1 hr ago", href: null },
      ],
      activity: [
        { source: "github", label: "Resolved", detail: "All review comments addressed", timestamp: "1 hr ago" },
      ],
    },
    {
      id: "regional-timeout",
      source: "slack",
      status: "needs-human",
      priority: "high",
      title: "Regional timeout follow-up lacks an owner",
      summary: "The incident is contained, but the follow-up work has no accountable owner and the customer impact summary is incomplete.",
      workspace: "Talacha",
      location: "#platform",
      participants: ["Ana", "Carlos", "5 people"],
      lastActivity: "2 hr ago",
      activityTimestamp: "2026-09-12T14:52:00.000Z",
      signalLabel: "Owner gap",
      decisionQuestion: "Who owns the customer impact summary and the follow-up remediation review?",
      confidence: 0.88,
      tags: ["incident", "follow-up"],
      signals: [
        "Error rates returned to baseline after the configuration rollback.",
        "The customer impact window is still being reconstructed.",
        "Two remediation ideas exist without an accountable owner.",
      ],
      evidence: [
        { source: "slack", label: "#platform", detail: "21 messages · 2 hr ago", href: null },
        { source: "github", label: "PR #161", detail: "remediation draft", href: null },
      ],
      activity: [
        { source: "slack", label: "Owner gap surfaced", detail: "Follow-up review has no accountable owner", timestamp: "2 hr ago" },
      ],
    },
  ],
};

export function filterConversations(
  conversations: MonitoredConversation[],
  filter: ConversationFilter | SourceFilter,
  query = "",
): MonitoredConversation[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return conversations.filter((conversation) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "open" && conversation.status !== "resolved") ||
      (filter === "needs-human" && conversation.status === "needs-human") ||
      (filter === conversation.source);
    const searchable = [
      conversation.title,
      conversation.summary,
      conversation.workspace,
      conversation.location,
      conversation.signalLabel,
      ...conversation.participants,
      ...(conversation.tags ?? []),
    ]
      .join(" ")
      .toLocaleLowerCase();

    return matchesFilter && (!normalizedQuery || searchable.includes(normalizedQuery));
  });
}

export function getMonitoringMetrics(conversations: MonitoredConversation[]): MonitoringMetrics {
  return conversations.reduce<MonitoringMetrics>(
    (metrics, conversation) => {
      if (conversation.status !== "resolved") metrics.open += 1;
      if (conversation.status === "needs-human") metrics.needsHuman += 1;
      if (conversation.source === "slack") metrics.slack += 1;
      if (conversation.source === "github") metrics.github += 1;
      return metrics;
    },
    { open: 0, needsHuman: 0, slack: 0, github: 0 },
  );
}
