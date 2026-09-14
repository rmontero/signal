"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  filterConversations,
  getMonitoringMetrics,
  type ConversationFilter,
  type MonitoredConversation,
  type MonitoringDashboardData,
  type SourceFilter,
} from "../lib/monitoring";
import {
  dashboardSectionFromHash,
  type ConnectorSummary,
  type DashboardSection,
} from "../lib/dashboard-settings";

const filterOptions: { label: string; value: ConversationFilter }[] = [
  { label: "Open", value: "open" },
  { label: "Needs attention", value: "needs-human" },
  { label: "Everything", value: "all" },
];

const sourceOptions: { label: string; value: SourceFilter }[] = [
  { label: "All sources", value: "all" },
  { label: "Slack", value: "slack" },
  { label: "GitHub PRs", value: "github" },
];

function sourceLabel(source: MonitoredConversation["source"]): string {
  return source === "slack" ? "Slack" : "GitHub PR";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function priorityLabel(priority: MonitoredConversation["priority"]): string {
  if (priority === "high") return "Needs attention";
  if (priority === "medium") return "Pending";
  return "Recorded outcome";
}

function SourceMark({ source }: { source: MonitoredConversation["source"] }) {
  return <span className={`source-mark source-mark-${source}`} aria-hidden="true">{source === "slack" ? "S" : "⌘"}</span>;
}

function AvatarStack({ participants }: { participants: string[] }) {
  return (
    <span className="avatar-stack" aria-label={`${participants.length} participants`}>
      {participants.slice(0, 3).map((participant, index) => (
        <span className={`avatar avatar-${index + 1}`} key={participant} title={participant}>
          {initials(participant)}
        </span>
      ))}
    </span>
  );
}

function ConversationCard({
  conversation,
  selected,
  onSelect,
}: {
  conversation: MonitoredConversation;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`conversation-card${selected ? " conversation-card-selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <div className="conversation-card-topline">
        <span className="source-label"><SourceMark source={conversation.source} />{sourceLabel(conversation.source)}</span>
        <span className={`priority priority-${conversation.priority}`}><span className="priority-dot" />{priorityLabel(conversation.priority)}</span>
      </div>
      <h3>{conversation.title}</h3>
      <p>{conversation.summary}</p>
      <div className="conversation-card-footer">
        <span className={`status status-${conversation.status}`}><span className="status-dot" />{conversation.signalLabel}</span>
        <time className="activity-time" dateTime={conversation.activityTimestamp} title="Record created; not the latest state-change time">{conversation.lastActivity}</time>
      </div>
      <div className="conversation-card-meta">
        <span>{conversation.location}</span>
        {conversation.participants.length > 0 && <><span className="meta-divider" /><AvatarStack participants={conversation.participants} /></>}
      </div>
    </button>
  );
}

function DetailPanel({ conversation }: { conversation: MonitoredConversation | null }) {
  if (!conversation) {
    return (
      <section className="detail-panel detail-panel-empty">
        <span className="empty-icon">⌕</span>
        <h2>No conversations match</h2>
        <p>Try a different filter or search term to bring a conversation back into view.</p>
      </section>
    );
  }

  const confidence = conversation.confidence === undefined ? null : Math.round(conversation.confidence * 100);
  const signals = conversation.signals ?? [conversation.summary];

  return (
    <section className="detail-panel" aria-live="polite">
      <div className="detail-header">
        <div>
          <div className="detail-kicker"><SourceMark source={conversation.source} /> {sourceLabel(conversation.source)} <span className="detail-separator">/</span> {conversation.location}</div>
          <h2>{conversation.title}</h2>
        </div>
        <span className={`status status-${conversation.status}`}><span className="status-dot" />{conversation.signalLabel}</span>
      </div>

      <div className="detail-summary">
        <p>{conversation.summary}</p>
        {confidence !== null && <span className="confidence"><span className="confidence-ring" />{confidence}% confidence</span>}
      </div>

      {conversation.decisionQuestion && (
        <div className="human-callout">
          <div className="callout-icon">!</div>
          <div>
            <p className="callout-label">Where a human adds value</p>
            <p className="callout-question">{conversation.decisionQuestion}</p>
          </div>
          <span className="action-guidance">Follow up in Slack. This dashboard cannot send requests or approve actions.</span>
        </div>
      )}

      <div className="detail-section">
        <div className="section-heading"><h3>Recorded state</h3><span className="section-note">Persisted snapshot</span></div>
        <ul className="signal-list">
          {signals.map((signal) => <li key={signal}><span className="signal-check" aria-hidden="true">·</span><span>{signal}</span></li>)}
        </ul>
      </div>

      <div className="detail-section">
        <div className="section-heading"><h3>Evidence trail</h3><span className="section-note">{conversation.evidence.length} references</span></div>
        <div className="evidence-list">
          {conversation.evidence.map((evidence) => (
            evidence.href ? (
              <a className="evidence-row" href={evidence.href} key={`${evidence.label}-${evidence.detail}`} target="_blank" rel="noopener noreferrer">
                <SourceMark source={evidence.source} />
                <span><strong>{evidence.label}</strong><small>{evidence.detail}</small></span>
                <span className="evidence-arrow" aria-hidden="true">↗</span>
              </a>
            ) : (
              <div className="evidence-row evidence-row-preview" key={`${evidence.label}-${evidence.detail}`}>
                <SourceMark source={evidence.source} />
                <span><strong>{evidence.label}</strong><small>{evidence.detail}</small></span>
                <span className="preview-ref">Persisted</span>
              </div>
            )
          ))}
        </div>
      </div>

      <div className="detail-section detail-section-last">
        <div className="section-heading"><h3>Record history</h3><span className="section-note">Creation timestamps</span></div>
        <div className="activity-list">
          {conversation.activity.map((entry) => (
            <div className="activity-row" key={`${entry.label}-${entry.timestamp}`}>
              <div className="activity-line"><SourceMark source={entry.source} /></div>
              <div className="activity-copy"><strong>{entry.label}</strong><span>{entry.detail}</span></div>
              <time>{entry.timestamp}</time>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const sidebarItems: { label: string; value: DashboardSection; icon: string }[] = [
  { label: "Overview", value: "overview", icon: "◈" },
  { label: "Conversations", value: "conversations", icon: "◌" },
  { label: "Decisions", value: "decisions", icon: "◇" },
  { label: "Activity", value: "activity", icon: "↗" },
];

const workspaceItems: { label: string; value: DashboardSection; icon: string }[] = [
  { label: "Sources", value: "sources", icon: "⌁" },
  { label: "Settings", value: "settings", icon: "⚙" },
];

function SidebarNavItem({
  item,
  active,
  count,
  onNavigate,
}: {
  item: { label: string; value: DashboardSection; icon: string };
  active: boolean;
  count?: number;
  onNavigate: (section: DashboardSection) => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`nav-item${active ? " nav-item-active" : ""}`}
      onClick={() => onNavigate(item.value)}
      type="button"
    >
      <span className="nav-icon">{item.icon}</span>
      {item.label}
      {count !== undefined && <span className={`nav-count${item.value === "decisions" ? " nav-count-warm" : ""}`}>{count}</span>}
    </button>
  );
}

function ConversationWorkspace({
  available,
  filter,
  filteredConversations,
  query,
  selectedConversation,
  source,
  onFilterChange,
  onQueryChange,
  onSelect,
  onSourceChange,
}: {
  available: boolean;
  filter: ConversationFilter;
  filteredConversations: MonitoredConversation[];
  query: string;
  selectedConversation: MonitoredConversation | null;
  source: SourceFilter;
  onFilterChange: (value: ConversationFilter) => void;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
  onSourceChange: (value: SourceFilter) => void;
}) {
  return (
    <section className="monitoring-workspace" id="conversations">
      <div className="conversation-column">
        <div className="section-title-row"><div><p className="eyebrow">Persisted records</p><h2>{filter === "all" ? "All conversations" : filter === "needs-human" ? "Conversations needing attention" : "Open conversations"}</h2></div><span className="queue-count">{available ? `${filteredConversations.length} showing` : "No snapshot available"}</span></div>
        <div className="toolbar">
          <div className="filter-tabs" role="group" aria-label="Conversation status">
            {filterOptions.map((option) => <button className={filter === option.value ? "filter-tab filter-tab-active" : "filter-tab"} key={option.value} onClick={() => onFilterChange(option.value)} type="button" aria-pressed={filter === option.value}>{option.label}</button>)}
          </div>
          <label className="search-field"><span aria-hidden="true">⌕</span><span className="sr-only">Search conversations</span><input onChange={(event) => onQueryChange(event.target.value)} placeholder="Search" type="search" value={query} /></label>
        </div>
        <div className="source-tabs" role="group" aria-label="Conversation source">
          {sourceOptions.map((option) => <button className={source === option.value ? "source-tab source-tab-active" : "source-tab"} key={option.value} onClick={() => onSourceChange(option.value)} type="button" aria-pressed={source === option.value}>{option.label}</button>)}
        </div>
        <div className="conversation-list">
          {filteredConversations.length ? filteredConversations.map((conversation) => <ConversationCard conversation={conversation} key={conversation.id} onSelect={() => onSelect(conversation.id)} selected={conversation.id === selectedConversation?.id} />) : <div className="list-empty"><span>⌕</span><strong>No matching records</strong><p>Check the data notice, change the filters or refresh. An empty view does not verify that the feeds are running.</p></div>}
        </div>
      </div>
      <DetailPanel conversation={selectedConversation} />
    </section>
  );
}

function OverviewView({
  data,
  metrics,
  onDecisionFilter,
  conversationWorkspace,
}: {
  data: MonitoringDashboardData;
  metrics: ReturnType<typeof getMonitoringMetrics>;
  onDecisionFilter: () => void;
  conversationWorkspace: React.ReactNode;
}) {
  const topDecision = data.conversations.find(({ status }) => status === "needs-human");

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Workspace monitoring</p><h1>Know what needs a human.</h1><p className="page-subtitle">Review persisted proposals and passive classifications. Feed health and current worker progress require separate verification.</p></div>
        <div className="heading-status"><span className="observer-orbit"><span /></span><div><strong>Passive monitoring snapshot</strong><span>{data.mode === "LIVE" ? "Records loaded · feed health unverified" : "Monitoring data unavailable"}</span></div></div>
      </section>

      <section className="metric-grid" aria-label="Monitoring summary">
        <div className="metric-card metric-card-primary"><span className="metric-label">Open records</span><strong>{data.mode === "LIVE" ? metrics.open : "—"}</strong><span className="metric-foot">In this monitoring snapshot</span><span className="metric-watermark">◌</span></div>
        <div className="metric-card"><span className="metric-label">Needs attention</span><strong>{data.mode === "LIVE" ? metrics.needsHuman : "—"}</strong><span className="metric-foot">Reviews, signals and blockers</span></div>
        <div className="metric-card"><span className="metric-label">Sources represented</span><strong>{data.mode === "LIVE" ? Number(metrics.slack > 0) + Number(metrics.github > 0) : "—"}</strong><span className="metric-foot"><span className="source-mini source-mini-slack">S</span> Slack <span className="source-mini source-mini-github">⌘</span> GitHub PRs</span></div>
        <div className="metric-card"><span className="metric-label">Noise filtered</span><strong>{data.mode === "LIVE" ? metrics.noiseFiltered : "—"}</strong><span className="metric-foot">Records classified as noise in this snapshot</span><span className="noise-ring noise-ring-empty">·</span></div>
      </section>

      <section className="attention-card">
        <div className="attention-accent" />
        <div className="attention-icon">!</div>
        <div className="attention-copy"><div className="attention-overline">{data.mode === "LIVE" ? `${metrics.needsHuman} records need attention` : "Monitoring status unknown"}</div><h2>{topDecision?.title ?? (data.mode === "LIVE" ? "No attention items in this snapshot" : "Monitoring data is unavailable")}</h2><p>{topDecision?.summary ?? (data.mode === "LIVE" ? "Refresh for the latest persisted records. Feed health is not verified by this view." : "Private monitoring requires Auth0 sign-in and active workspace membership. Open Settings for provider setup requirements and check the data notice above.")}</p></div>
        <button className="attention-action" onClick={onDecisionFilter} type="button">See attention items <span aria-hidden="true">→</span></button>
      </section>

      {conversationWorkspace}
    </>
  );
}

function EmptySection({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return <div className="section-empty"><span className="empty-icon">{icon}</span><h2>{title}</h2><p>{detail}</p></div>;
}

function DecisionsView({ available, conversations, onOpenConversation }: { available: boolean; conversations: MonitoredConversation[]; onOpenConversation: (id: string) => void }) {
  const decisions = conversations.filter(({ status }) => status === "needs-human");
  return (
    <section className="workspace-section" id="decisions">
      <div className="section-title-row"><div><p className="eyebrow">Human review</p><h2>Decisions and blockers</h2></div><span className="queue-count">{available ? `${decisions.length} in this snapshot` : "No snapshot available"}</span></div>
      {decisions.length ? <div className="decision-grid">{decisions.map((conversation) => <button className="decision-card" key={conversation.id} onClick={() => onOpenConversation(conversation.id)} type="button"><div className="decision-card-topline"><SourceMark source={conversation.source} /><span>{conversation.signalLabel}</span><span className="priority priority-high"><span className="priority-dot" />Needs attention</span></div><h3>{conversation.title}</h3><p>{conversation.decisionQuestion ?? conversation.summary}</p><span className="decision-card-action">Open conversation ↗</span></button>)}</div> : <EmptySection icon="◇" title="No attention items loaded" detail="No matching records are available in this snapshot. Check the data notice and refresh before concluding that nothing needs attention." />}
    </section>
  );
}

function ActivityView({ available, conversations }: { available: boolean; conversations: MonitoredConversation[] }) {
  const activity = [...conversations].sort((a, b) => b.activityTimestamp.localeCompare(a.activityTimestamp)).flatMap((conversation) => conversation.activity.map((entry, index) => ({ ...entry, id: `${conversation.id}:${index}`, conversationTitle: conversation.title })));
  return (
    <section className="workspace-section" id="activity">
      <div className="section-title-row"><div><p className="eyebrow">Observer timeline</p><h2>Recent activity</h2></div><span className="queue-count">{available ? `${activity.length} events` : "No snapshot available"}</span></div>
      {activity.length ? <div className="activity-feed">{activity.map((entry) => <div className="activity-feed-row" key={entry.id}><SourceMark source={entry.source} /><div><strong>{entry.label}</strong><span>{entry.conversationTitle}</span><small>{entry.detail}</small></div><time>{entry.timestamp}</time></div>)}</div> : <EmptySection icon="↗" title="No activity loaded" detail="No record history is available in this snapshot. Check the data notice and refresh to load newly persisted events." />}
    </section>
  );
}

function connectorStatusLabel(status: ConnectorSummary["status"]): string {
  if (status === "ready") return "Configured · unverified";
  if (status === "needs-config") return "Needs configuration";
  return "Not configured";
}

function ConnectorCard({ connector, expanded, onToggle }: { connector: ConnectorSummary; expanded: boolean; onToggle: () => void }) {
  return (
    <article className={`connector-card connector-card-${connector.status}`}>
      <div className="connector-card-header"><div className={`connector-logo connector-logo-${connector.id}`}>{connector.id === "github" ? "⌘" : connector.name.slice(0, 1)}</div><div className="connector-card-title"><span>{connector.category}</span><h3>{connector.name}</h3></div><span className={`connector-status connector-status-${connector.status}`}><span className="status-dot" />{connectorStatusLabel(connector.status)}</span></div>
      <p>{connector.detail}</p>
      <div className="connector-card-footer"><span>{connector.required.length} configuration names</span><button className="connector-action" onClick={onToggle} type="button" aria-expanded={expanded} aria-controls={`setup-${connector.id}`}>{expanded ? "Hide details" : "View setup requirements"}</button></div>
      {expanded && <div className="connector-requirements" id={`setup-${connector.id}`}><strong>Required names</strong><div>{connector.required.map((name) => <code key={name}>{name}</code>)}</div><small>An operator must update the server or worker environment and verify the integration. This panel cannot save settings, connect accounts or grant permissions.</small></div>}
    </article>
  );
}

function SourcesView({ connectors, onOpenSettings }: { connectors: ConnectorSummary[]; onOpenSettings: () => void }) {
  const sourceConnectors = connectors.filter(({ id }) => id === "slack" || id === "github");
  return (
    <section className="workspace-section" id="sources">
      <div className="section-title-row"><div><p className="eyebrow">Passive inputs</p><h2>Sources</h2></div><span className="queue-count">Feed health unverified</span></div>
      <p className="section-intro">Slack Events API and GitHub pull-request webhooks are the pilot sources. The configuration checks below do not prove event delivery or classification. Review the recorded event states and verify the worker separately.</p>
      <div className="source-grid">{sourceConnectors.map((connector) => <div className="source-overview-card" key={connector.id}><div className={`connector-logo connector-logo-${connector.id}`}>{connector.id === "github" ? "⌘" : connector.name.slice(0, 1)}</div><div><span className="source-overview-category">{connector.category}</span><h3>{connector.name}</h3><p>{connector.detail}</p></div><span className={`connector-status connector-status-${connector.status}`}>{connectorStatusLabel(connector.status)}</span></div>)}</div>
      <button className="secondary-action" onClick={onOpenSettings} type="button">View setup requirements <span aria-hidden="true">→</span></button>
    </section>
  );
}

function SettingsView({ connectors }: { connectors: ConnectorSummary[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const ready = connectors.filter(({ status }) => status === "ready").length;
  return (
    <section className="workspace-section settings-section" id="settings">
      <div className="section-title-row"><div><p className="eyebrow">Authentication and provider setup</p><h2>Settings</h2></div><span className="queue-count">{ready}/{connectors.length} have required names</span></div>
      <div className="settings-callout"><div className="settings-callout-icon">⚙</div><div><strong>Read-only setup information</strong><p>Auth0 sign-in and active workspace membership control access to private monitoring. Signing in does not connect Slack or GitHub. This panel reports legacy operator configuration names; it cannot change configuration, connect providers or verify the worker environment. An operator must configure mappings and providers and verify actual delivery. Refresh the dashboard after setup.</p></div></div>
      <a className="secondary-action" href="/settings">Manage workspace connections <span aria-hidden="true">→</span></a>
      <div className="connector-grid">{connectors.map((connector) => <ConnectorCard connector={connector} expanded={expandedId === connector.id} key={connector.id} onToggle={() => setExpandedId(expandedId === connector.id ? null : connector.id)} />)}</div>
      <div className="settings-boundaries"><strong>Runtime boundaries</strong><span>Trigger.dev is the background runtime</span><span>OpenRouter is the only model route</span><span>Named Slack approval is required for GitHub actions</span><span>Auth0 membership is resolved on the server; setup configuration does not grant access</span></div>
    </section>
  );
}

export function MonitoringDashboard({ data: receivedData }: { data: MonitoringDashboardData }) {
  // The server loader enforces viewer authorization before serialization. Also
  // discard stale records when an unavailable response reaches the renderer.
  const data = useMemo(() => receivedData.mode === "LIVE" ? receivedData : { ...receivedData, conversations: [] }, [receivedData]);
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [filter, setFilter] = useState<ConversationFilter>("open");
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(data.conversations[0]?.id ?? null);
  const [section, setSection] = useState<DashboardSection>("overview");
  const metrics = useMemo(() => getMonitoringMetrics(data.conversations), [data.conversations]);
  const filteredConversations = useMemo(() => {
    const byStatus = filterConversations(data.conversations, filter);
    return source === "all" ? filterConversations(byStatus, "all", query) : filterConversations(byStatus, source, query);
  }, [data.conversations, filter, query, source]);
  const selectedConversation = filteredConversations.find(({ id }) => id === selectedId) ?? filteredConversations[0] ?? null;

  useEffect(() => {
    const syncSection = () => setSection(dashboardSectionFromHash(window.location.hash));
    syncSection();
    window.addEventListener("hashchange", syncSection);
    window.addEventListener("popstate", syncSection);
    return () => {
      window.removeEventListener("hashchange", syncSection);
      window.removeEventListener("popstate", syncSection);
    };
  }, []);

  function navigate(nextSection: DashboardSection) {
    setSection(nextSection);
    if (window.location.hash !== `#${nextSection}`) window.history.pushState({}, "", `#${nextSection}`);
  }

  function openConversation(id: string) {
    setFilter("all");
    setSource("all");
    setQuery("");
    setSelectedId(id);
    navigate("conversations");
  }

  const conversationWorkspace = (
    <ConversationWorkspace
      available={data.mode === "LIVE"}
      filter={filter}
      filteredConversations={filteredConversations}
      onFilterChange={setFilter}
      onQueryChange={setQuery}
      onSelect={setSelectedId}
      onSourceChange={setSource}
      query={query}
      selectedConversation={selectedConversation}
      source={source}
    />
  );

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">✦</div>
          <div><strong>Signal</strong><span>Conversation intelligence</span></div>
        </div>

        <button className="workspace-switcher" type="button" onClick={() => navigate("settings")} aria-label="View workspace setup">
          <span className="workspace-avatar">S</span>
          <span><strong>Signal workspace</strong><small>{data.mode === "LIVE" ? "Authorized workspace snapshot" : "Public setup shell"}</small></span>
          <span className="workspace-chevron" aria-hidden="true">⚙</span>
        </button>

        <nav className="primary-nav" aria-label="Primary navigation">
          {sidebarItems.map((item) => <SidebarNavItem active={section === item.value} count={data.mode !== "LIVE" ? undefined : item.value === "conversations" ? metrics.open : item.value === "decisions" ? metrics.needsHuman : undefined} item={item} key={item.value} onNavigate={navigate} />)}
        </nav>

        <div className="sidebar-rule" />
        <div className="sidebar-label">Workspace</div>
        <nav className="secondary-nav" aria-label="Workspace navigation">
          {workspaceItems.map((item) => <SidebarNavItem active={section === item.value} item={item} key={item.value} onNavigate={navigate} />)}
        </nav>

        <div className="sidebar-footer">
          <div className="observer-state"><span className="live-dot live-dot-muted" /><span><strong>{data.mode === "LIVE" ? "Snapshot loaded" : "Data unavailable"}</strong><small>Feed health unverified</small></span></div>
          <div className="user-row"><span className="user-avatar" aria-hidden="true">S</span><span><strong>Workspace dashboard</strong><small>Read-only · Approvals in Slack</small></span></div>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{section[0].toUpperCase() + section.slice(1)}</strong></div>
          <div className="topbar-actions"><span className="last-updated">{data.mode === "LIVE" && data.loadedAt ? `Snapshot ${data.loadedAt.replace("T", " ").slice(0, 19)} UTC` : "No current snapshot"}</span><button className="refresh-button" type="button" disabled={refreshing} onClick={() => startRefresh(() => router.refresh())}>{refreshing ? "Refreshing…" : "Refresh records"}</button><button className="help-button" type="button" aria-label="Setup help" onClick={() => navigate("settings")}>?</button><button className="top-avatar" type="button" aria-label="Open settings" onClick={() => navigate("settings")}>⚙</button></div>
        </header>

        <div className="dashboard-content">
          <div className={`preview-banner${data.mode === "LIVE" ? " live-banner" : " unavailable-banner"}`} role="status"><span><strong>{data.mode === "LIVE" ? "Persisted snapshot" : "Data unavailable"}</strong> {data.notice}</span><span className="banner-model">Read-only monitoring</span></div>

          <div className="section-view">
            {section === "overview" && <OverviewView data={data} metrics={metrics} onDecisionFilter={() => navigate("decisions")} conversationWorkspace={conversationWorkspace} />}
            {section === "conversations" && conversationWorkspace}
            {section === "decisions" && <DecisionsView available={data.mode === "LIVE"} conversations={data.conversations} onOpenConversation={openConversation} />}
            {section === "activity" && <ActivityView available={data.mode === "LIVE"} conversations={data.conversations} />}
            {section === "sources" && <SourcesView connectors={data.connectors} onOpenSettings={() => navigate("settings")} />}
            {section === "settings" && <SettingsView connectors={data.connectors} />}
          </div>

          <footer className="dashboard-footer"><span>Read-only monitoring</span><span>{data.mode === "LIVE" ? "Authorized workspace · Snapshot may be outdated" : "Workspace access and provider setup required"}</span><span>GitHub approvals happen in Slack</span></footer>
        </div>
      </main>
    </div>
  );
}
