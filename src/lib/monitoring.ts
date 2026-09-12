import type { PersistedConversationRow } from "../domain/contracts";
import type { ConnectorSummary } from "./dashboard-settings";

export type { PersistedConversationRow } from "../domain/contracts";

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
  mode: "UNAVAILABLE" | "LIVE";
  notice: string;
  conversations: MonitoredConversation[];
  connectors: ConnectorSummary[];
};

function formatPersistedDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

function proposalTitle(mutation: unknown): string | null {
  if (!mutation || typeof mutation !== "object") return null;
  const title = (mutation as { title?: unknown }).title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

export function mapPersistedConversation(row: PersistedConversationRow): MonitoredConversation {
  const resolved = row.operationState === "SUCCEEDED" || ["DISMISSED", "SUPERSEDED", "EXPIRED"].includes(row.proposalState ?? "");
  const attention = row.proposalState === "PENDING" || row.operationState === "UNKNOWN";
  const activityDate = row.operationCreatedAt ?? row.threadCreatedAt;
  const title = proposalTitle(row.proposalMutation) ?? `Conversation in #${row.channelId}`;

  return {
    id: `${row.tenantId}:${row.threadId}`,
    source: "slack",
    status: resolved ? "resolved" : attention ? "needs-human" : "monitoring",
    priority: attention ? "high" : resolved ? "low" : "medium",
    title,
    summary: row.proposalState === "PENDING"
      ? "A persisted issue proposal is waiting for named Slack approval."
      : row.operationState === "UNKNOWN"
        ? "The last external operation is uncertain and requires reconciliation before any retry."
        : "Signal is monitoring this tenant-scoped Slack thread.",
    workspace: `${row.repositoryOwner}/${row.repositoryName}`,
    location: `#${row.channelId}`,
    participants: ["Slack thread"],
    lastActivity: formatPersistedDate(activityDate),
    activityTimestamp: activityDate.toISOString(),
    signalLabel: row.proposalState === "PENDING" ? "Decision gap" : row.operationState === "UNKNOWN" ? "Reconciliation needed" : resolved ? "Resolved" : "Monitoring",
    decisionQuestion: row.proposalState === "PENDING"
      ? "Can a named Slack approver review this proposal?"
      : row.operationState === "UNKNOWN"
        ? "Can the operation be reconciled before any further action?"
        : null,
    evidence: [
      { source: "slack", label: "Slack thread", detail: `Thread ${row.threadTs}`, href: null },
    ],
    activity: [
      {
        source: "slack",
        label: row.proposalState === "PENDING" ? "Proposal persisted" : "Thread persisted",
        detail: row.proposalState === "PENDING" ? "Awaiting named Slack approval" : "Tenant-scoped record loaded from Neon",
        timestamp: formatPersistedDate(activityDate),
      },
    ],
    confidence: undefined,
    tags: row.proposalState === "PENDING" ? ["proposal", "approval"] : ["thread"],
    signals: row.proposalState === "PENDING"
      ? [`Proposal version ${row.proposalVersion ?? "unknown"} is persisted for review.`]
      : ["No model-generated signal is stored for this record yet."],
  };
}

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
