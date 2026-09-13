import type { PersistedConversationRow, PersistedObserverRow } from "../domain/contracts";
import type { ConnectorSummary } from "./dashboard-settings";

export type { PersistedConversationRow } from "../domain/contracts";
export type { PersistedObserverRow } from "../domain/contracts";

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
  noiseFiltered: number;
};

export type MonitoringDashboardData = {
  mode: "UNAVAILABLE" | "LIVE";
  loadedAt?: string;
  notice: string;
  conversations: MonitoredConversation[];
  connectors: ConnectorSummary[];
};

function formatPersistedDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(value);
}

function proposalTitle(mutation: unknown): string | null {
  if (!mutation || typeof mutation !== "object") return null;
  const title = (mutation as { title?: unknown }).title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

type ConversationRow = PersistedConversationRow & { proposalExpiresAt?: Date | null };
type ObserverRow = PersistedObserverRow & { executionState?: string | null };
type Presentation = Pick<MonitoredConversation, "status" | "priority" | "signalLabel" | "summary" | "decisionQuestion">;

function presentation(signalLabel: string, status: ConversationStatus, summary: string, decisionQuestion: string | null = null): Presentation {
  return { signalLabel, status, summary, decisionQuestion, priority: status === "needs-human" ? "high" : status === "resolved" ? "low" : "medium" };
}

function persistedPresentation(row: ConversationRow, now: Date): Presentation {
  // Uncertain or in-flight writes must never be hidden by a terminal proposal state.
  if (row.operationState === "UNKNOWN") return presentation("Reconciliation needed", "needs-human", "The GitHub outcome is uncertain. Reconcile the existing operation; do not retry or create a replacement.", "Can an operator reconcile the uncertain operation?");
  if (row.operationState === "SENDING") return presentation("Action in progress", "monitoring", "The persisted operation is in progress. GitHub completion has not been confirmed.");
  if (row.operationState === "FAILED") return presentation("Action failed", "needs-human", "The operation definitively failed without creating the GitHub action. Review the failure in Slack before requesting a new proposal.", "Can an operator review the failed action?");
  if (row.operationState === "SUCCEEDED") return presentation("Action succeeded", "resolved", "The GitHub action is recorded as successful. This does not confirm Slack notification delivery or resolution of the conversation.");
  if (row.proposalState === "DISMISSED") return presentation("Proposal dismissed", "resolved", "The proposal was dismissed without executing its GitHub action.");
  if (row.proposalState === "SUPERSEDED") return presentation("Proposal superseded", "resolved", "A newer proposal replaced this draft. This draft cannot be approved.");
  if (row.proposalState === "EXPIRED" || (row.proposalState === "PENDING" && row.proposalExpiresAt && row.proposalExpiresAt.getTime() <= now.getTime())) {
    return presentation("Proposal expired", "resolved", "The proposal's review window has expired. A new explicit Slack request is required for a fresh proposal.");
  }
  if (row.operationState === "STALE") return presentation("Fresh review required", "needs-human", "Authorization or target eligibility changed before sending. The existing action cannot execute; a fresh Slack review is required.", "Can an authorized Slack user request a fresh proposal?");
  if ((row.operationState && row.operationState !== "READY") || (row.proposalState && !["PENDING", "APPROVED"].includes(row.proposalState))) {
    return presentation("State unavailable", "needs-human", "This record has an unrecognized state. An operator must inspect it before further action.");
  }
  if (row.proposalState === "PENDING") {
    const kind = row.proposalMutation && typeof row.proposalMutation === "object" && "kind" in row.proposalMutation && row.proposalMutation.kind === "ADD_PROGRESS_COMMENT" ? "progress comment" : "GitHub action";
    return presentation("Pending Slack review", "needs-human", `A persisted ${kind} proposal is pending review. Slack checks the named approver, current payload and expiry before approval.`, "Can a named approver review the exact persisted proposal in Slack?");
  }
  if (row.proposalState === "APPROVED") return presentation("Approved · awaiting result", "monitoring", "Slack approval is recorded. This snapshot contains no confirmed GitHub result; worker progress is not available here.");
  return presentation("Awaiting analysis", "monitoring", "A Slack thread is persisted, but no proposal or completed analysis is available in this snapshot. Worker progress is not available here.");
}

function slackHref(channelId: string | null, timestamp: string | null): string | null {
  return channelId && /^[CG][A-Z0-9]+$/.test(channelId) && timestamp && /^\d{10,}\.\d{6}$/.test(timestamp)
    ? `https://slack.com/archives/${channelId}/p${timestamp.replace(".", "")}`
    : null;
}

export function mapPersistedConversation(row: ConversationRow): MonitoredConversation {
  const state = persistedPresentation(row, new Date());
  const activityDate = row.operationCreatedAt ?? row.threadCreatedAt;
  const title = proposalTitle(row.proposalMutation) ?? `Conversation in #${row.channelId}`;

  return {
    id: `thread:${row.threadId}`,
    source: "slack",
    ...state,
    title,
    workspace: `${row.repositoryOwner}/${row.repositoryName}`,
    location: `#${row.channelId}`,
    participants: [],
    lastActivity: formatPersistedDate(activityDate),
    activityTimestamp: activityDate.toISOString(),
    evidence: [
      { source: "slack", label: "Slack thread", detail: `Thread ${row.threadTs}`, href: slackHref(row.channelId, row.threadTs) },
    ],
    activity: [
      {
        source: "slack",
        label: row.operationCreatedAt ? "Operation record created" : "Thread record created",
        detail: `Current recorded state: ${state.signalLabel}. State-change time is not available.`,
        timestamp: formatPersistedDate(activityDate),
      },
    ],
    confidence: undefined,
    tags: row.proposalState === "PENDING" ? ["proposal", "approval"] : ["thread"],
    signals: [state.summary],
  };
}

export function mapObservedConversation(row: ObserverRow): MonitoredConversation {
  const isNoise = row.classificationState === "NOISE";
  const isSignal = row.classificationState === "SIGNAL";
  const source = row.source;
  const repo = row.repositoryOwner && row.repositoryName ? `${row.repositoryOwner}/${row.repositoryName}` : "Mapped workspace";
  const location = source === "slack" ? `#${row.channelId ?? "unknown"}` : `${repo} · PR #${row.pullRequestNumber ?? "?"}`;
  const title = source === "slack" ? `Slack conversation in ${location}` : `Pull request #${row.pullRequestNumber ?? "?"} · ${repo}`;
  const evidenceHref = source === "github" && row.repositoryOwner && /^[A-Za-z0-9-]+$/.test(row.repositoryOwner) && row.repositoryName && /^[A-Za-z0-9_.-]+$/.test(row.repositoryName) && ![".", ".."].includes(row.repositoryName) && Number.isSafeInteger(row.pullRequestNumber) && (row.pullRequestNumber ?? 0) > 0
    ? `https://github.com/${row.repositoryOwner}/${row.repositoryName}/pull/${row.pullRequestNumber}`
    : source === "slack"
      ? slackHref(row.channelId, row.messageTs ?? row.threadTs)
      : null;
  const state = isNoise
    ? presentation("Noise filtered", "resolved", "This event is recorded as noise. No human action was proposed by passive observation.")
    : isSignal
      ? presentation("Meaningful signal", "needs-human", row.classificationReason?.trim() || "This event is recorded as a signal for human review. Observation does not authorize a GitHub action.", "Does this signal warrant an explicit request in Slack?")
      : row.classificationState === "BLOCKED" || row.executionState === "BLOCKED"
        ? presentation("Classification blocked", "needs-human", "Classification is blocked. An operator must check the worker's recorded blocker and configured source access; no classification result is available.", "Can an operator resolve the classification blocker?")
        : row.executionState === "FAILED"
          ? presentation("Classification failed", "needs-human", "The observer worker failed before a classification result was stored. Review the failed run before proceeding.", "Can an operator review the failed classification?")
          : row.classificationState !== "PENDING" || (row.executionState && !["READY", "RUNNING"].includes(row.executionState))
            ? presentation("Classification unavailable", "needs-human", "No usable classification result is recorded. An operator must inspect the worker state.")
            : presentation(row.executionState === "RUNNING" ? "Classification in progress" : "Classification pending", "monitoring", row.executionState === "RUNNING" ? "The worker is recorded as running. Classification has not completed." : row.executionState === "READY" ? "The observer job is recorded as ready. Classification has not started." : "The verified event is persisted and classification is pending. Worker execution state is not available in this snapshot.");
  return {
    id: `observer:${row.eventId}`,
    source,
    ...state,
    title,
    workspace: repo,
    location,
    participants: [],
    lastActivity: formatPersistedDate(row.createdAt),
    activityTimestamp: row.createdAt.toISOString(),
    evidence: [{ source, label: source === "slack" ? "Slack event" : "GitHub pull request", detail: row.eventType, href: evidenceHref }],
    activity: [{ source, label: "Observer event received", detail: `Current recorded state: ${state.signalLabel}. Classification time is not available.`, timestamp: formatPersistedDate(row.createdAt) }],
    tags: ["observer", row.classificationState.toLowerCase()],
    signals: [state.summary],
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
      if (conversation.signalLabel === "Noise filtered") metrics.noiseFiltered += 1;
      return metrics;
    },
    { open: 0, needsHuman: 0, slack: 0, github: 0, noiseFiltered: 0 },
  );
}
