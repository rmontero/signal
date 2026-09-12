"use client";

import { useEffect, useMemo, useState } from "react";
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
  { label: "Needs your call", value: "needs-human" },
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

function statusLabel(status: MonitoredConversation["status"]): string {
  if (status === "needs-human") return "Needs your call";
  if (status === "monitoring") return "Monitoring";
  return "Resolved";
}

function priorityLabel(priority: MonitoredConversation["priority"]): string {
  if (priority === "high") return "High signal";
  if (priority === "medium") return "Worth watching";
  return "Low signal";
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
        <span className={`status status-${conversation.status}`}><span className="status-dot" />{statusLabel(conversation.status)}</span>
        <span className="activity-time">{conversation.lastActivity}</span>
      </div>
      <div className="conversation-card-meta">
        <span>{conversation.location}</span>
        <span className="meta-divider" />
        <AvatarStack participants={conversation.participants} />
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
        <span className={`status status-${conversation.status}`}><span className="status-dot" />{statusLabel(conversation.status)}</span>
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
          <button className="text-button" type="button" disabled title="Question dispatch is part of the live listener integration">
            Ask squad <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}

      <div className="detail-section">
        <div className="section-heading"><h3>What Signal sees</h3><span className="section-note">Read-only synthesis</span></div>
        <ul className="signal-list">
          {signals.map((signal) => <li key={signal}><span className="signal-check">✓</span><span>{signal}</span></li>)}
        </ul>
      </div>

      <div className="detail-section">
        <div className="section-heading"><h3>Evidence trail</h3><span className="section-note">{conversation.evidence.length} references</span></div>
        <div className="evidence-list">
          {conversation.evidence.map((evidence) => (
            evidence.href ? (
              <a className="evidence-row" href={evidence.href} key={`${evidence.label}-${evidence.detail}`}>
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
        <div className="section-heading"><h3>Recent activity</h3><span className="section-note">Agent timeline</span></div>
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
        <div className="section-title-row"><div><p className="eyebrow">Live queue</p><h2>Open conversations</h2></div><span className="queue-count">{filteredConversations.length} showing</span></div>
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
          {filteredConversations.length ? filteredConversations.map((conversation) => <ConversationCard conversation={conversation} key={conversation.id} onSelect={() => onSelect(conversation.id)} selected={conversation.id === selectedConversation?.id} />) : <div className="list-empty"><span>⌕</span><strong>Nothing here yet</strong><p>Signal will bring a conversation here when it finds a meaningful change.</p></div>}
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
        <div><p className="eyebrow">Executive operating room</p><h1>Know what needs a human.</h1><p className="page-subtitle">Signal surfaces persisted decisions, risks, and owner gaps while keeping the intelligence layer read-only.</p></div>
        <div className="heading-status"><span className="observer-orbit"><span /></span><div><strong>Passive observer</strong><span>{data.mode === "LIVE" ? "Neon records · feeds pending" : "Slack + GitHub feeds pending"}</span></div></div>
      </section>

      <section className="metric-grid" aria-label="Monitoring summary">
        <div className="metric-card metric-card-primary"><span className="metric-label">Open conversations</span><strong>{metrics.open}</strong><span className="metric-foot">From persisted tenant records</span><span className="metric-watermark">◌</span></div>
        <div className="metric-card"><span className="metric-label">Needs your call</span><strong>{metrics.needsHuman}</strong><span className="metric-foot">Human input has leverage</span><span className="metric-spark">▁▃▂▅▃▆</span></div>
        <div className="metric-card"><span className="metric-label">Signal sources</span><strong>{metrics.slack + metrics.github}</strong><span className="metric-foot"><span className="source-mini source-mini-slack">S</span> Slack <span className="source-mini source-mini-github">⌘</span> GitHub PRs</span></div>
        <div className="metric-card"><span className="metric-label">Noise filtered</span><strong>{metrics.noiseFiltered}</strong><span className="metric-foot">Observer events filtered from the queue</span><span className="noise-ring noise-ring-empty">·</span></div>
      </section>

      <section className="attention-card">
        <div className="attention-accent" />
        <div className="attention-icon">!</div>
        <div className="attention-copy"><div className="attention-overline">Top signal · {data.conversations.filter(({ priority }) => priority === "high").length} high-value threads</div><h2>{topDecision?.title ?? "No open decision gaps"}</h2><p>{topDecision?.summary ?? "Signal is monitoring the workspace for meaningful changes."}</p></div>
        <button className="attention-action" onClick={onDecisionFilter} type="button">See decision gaps <span aria-hidden="true">→</span></button>
      </section>

      {conversationWorkspace}
    </>
  );
}

function EmptySection({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return <div className="section-empty"><span className="empty-icon">{icon}</span><h2>{title}</h2><p>{detail}</p></div>;
}

function DecisionsView({ conversations, onOpenConversation }: { conversations: MonitoredConversation[]; onOpenConversation: (id: string) => void }) {
  const decisions = conversations.filter(({ status }) => status === "needs-human");
  return (
    <section className="workspace-section" id="decisions">
      <div className="section-title-row"><div><p className="eyebrow">Human leverage</p><h2>Decisions needing your call</h2></div><span className="queue-count">{decisions.length} open</span></div>
      {decisions.length ? <div className="decision-grid">{decisions.map((conversation) => <button className="decision-card" key={conversation.id} onClick={() => onOpenConversation(conversation.id)} type="button"><div className="decision-card-topline"><SourceMark source={conversation.source} /><span>{conversation.signalLabel}</span><span className="priority priority-high"><span className="priority-dot" />High signal</span></div><h3>{conversation.title}</h3><p>{conversation.decisionQuestion ?? conversation.summary}</p><span className="decision-card-action">Open conversation ↗</span></button>)}</div> : <EmptySection icon="◇" title="No decisions waiting" detail="When a persisted proposal needs an authorized human decision, it will appear here." />}
    </section>
  );
}

function ActivityView({ conversations }: { conversations: MonitoredConversation[] }) {
  const activity = conversations.flatMap((conversation) => conversation.activity.map((entry) => ({ ...entry, conversationTitle: conversation.title })));
  return (
    <section className="workspace-section" id="activity">
      <div className="section-title-row"><div><p className="eyebrow">Observer timeline</p><h2>Recent activity</h2></div><span className="queue-count">{activity.length} events</span></div>
      {activity.length ? <div className="activity-feed">{activity.map((entry) => <div className="activity-feed-row" key={`${entry.conversationTitle}-${entry.label}-${entry.timestamp}`}><SourceMark source={entry.source} /><div><strong>{entry.label}</strong><span>{entry.conversationTitle}</span><small>{entry.detail}</small></div><time>{entry.timestamp}</time></div>)}</div> : <EmptySection icon="↗" title="No activity yet" detail="Persisted observer events will appear here as Slack and GitHub conversations are ingested." />}
    </section>
  );
}

function connectorStatusLabel(status: ConnectorSummary["status"]): string {
  if (status === "ready") return "Ready";
  if (status === "needs-config") return "Needs configuration";
  return "Not configured";
}

function ConnectorCard({ connector, expanded, onToggle }: { connector: ConnectorSummary; expanded: boolean; onToggle: () => void }) {
  return (
    <article className={`connector-card connector-card-${connector.status}`}>
      <div className="connector-card-header"><div className={`connector-logo connector-logo-${connector.id}`}>{connector.id === "github" ? "⌘" : connector.name.slice(0, 1)}</div><div className="connector-card-title"><span>{connector.category}</span><h3>{connector.name}</h3></div><span className={`connector-status connector-status-${connector.status}`}><span className="status-dot" />{connectorStatusLabel(connector.status)}</span></div>
      <p>{connector.detail}</p>
      <div className="connector-card-footer"><span>{connector.required.length} server-only values</span><button className="connector-action" onClick={onToggle} type="button" aria-expanded={expanded}>{expanded ? "Hide details" : connector.status === "ready" ? "Review setup" : "Configure"}</button></div>
      {expanded && <div className="connector-requirements"><strong>Required names</strong><div>{connector.required.map((name) => <code key={name}>{name}</code>)}</div><small>Values are never displayed in the dashboard.</small></div>}
    </article>
  );
}

function SourcesView({ connectors, onOpenSettings }: { connectors: ConnectorSummary[]; onOpenSettings: () => void }) {
  const sourceConnectors = connectors.filter(({ id }) => id === "slack" || id === "github");
  return (
    <section className="workspace-section" id="sources">
      <div className="section-title-row"><div><p className="eyebrow">Passive inputs</p><h2>Sources</h2></div><span className="queue-count">{sourceConnectors.filter(({ status }) => status === "ready").length}/{sourceConnectors.length} ready</span></div>
      <p className="section-intro">Slack Events API and GitHub pull-request webhooks are the two observer feeds. Deterministic filters and the Luna classifier run after verified events are persisted.</p>
      <div className="source-grid">{sourceConnectors.map((connector) => <div className="source-overview-card" key={connector.id}><div className={`connector-logo connector-logo-${connector.id}`}>{connector.id === "github" ? "⌘" : connector.name.slice(0, 1)}</div><div><span className="source-overview-category">{connector.category}</span><h3>{connector.name}</h3><p>{connector.detail}</p></div><span className={`connector-status connector-status-${connector.status}`}>{connectorStatusLabel(connector.status)}</span></div>)}</div>
      <button className="secondary-action" onClick={onOpenSettings} type="button">Manage connector configuration <span aria-hidden="true">→</span></button>
    </section>
  );
}

function SettingsView({ connectors }: { connectors: ConnectorSummary[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const ready = connectors.filter(({ status }) => status === "ready").length;
  return (
    <section className="workspace-section settings-section" id="settings">
      <div className="section-title-row"><div><p className="eyebrow">Workspace controls</p><h2>Settings</h2></div><span className="queue-count">{ready}/{connectors.length} connectors ready</span></div>
      <div className="settings-callout"><div className="settings-callout-icon">⚙</div><div><strong>Server-side connector configuration</strong><p>Signal only reports whether required names are present. Secrets stay in the server environment and are never sent to the browser.</p></div></div>
      <div className="connector-grid">{connectors.map((connector) => <ConnectorCard connector={connector} expanded={expandedId === connector.id} key={connector.id} onToggle={() => setExpandedId(expandedId === connector.id ? null : connector.id)} />)}</div>
      <div className="settings-boundaries"><strong>Runtime boundaries</strong><span>Trigger.dev runs background work</span><span>OpenRouter is the only model route</span><span>GitHub writes remain limited to approved actions</span><span>Dashboard access is tenant-scoped</span></div>
    </section>
  );
}

export function MonitoringDashboard({ data }: { data: MonitoringDashboardData }) {
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
    return () => window.removeEventListener("hashchange", syncSection);
  }, []);

  function navigate(nextSection: DashboardSection) {
    setSection(nextSection);
    window.history.pushState({}, "", `#${nextSection}`);
  }

  function openConversation(id: string) {
    setSelectedId(id);
    navigate("conversations");
  }

  const conversationWorkspace = (
    <ConversationWorkspace
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

        <div className="workspace-switcher">
          <span className="workspace-avatar">S</span>
          <span><strong>Signal workspace</strong><small>{data.mode === "LIVE" ? "Tenant-scoped view" : "Awaiting tenant context"}</small></span>
          <span className="workspace-chevron">⌄</span>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {sidebarItems.map((item) => <SidebarNavItem active={section === item.value} count={item.value === "conversations" ? metrics.open : item.value === "decisions" ? metrics.needsHuman : undefined} item={item} key={item.value} onNavigate={navigate} />)}
        </nav>

        <div className="sidebar-rule" />
        <div className="sidebar-label">Workspace</div>
        <nav className="secondary-nav" aria-label="Workspace navigation">
          {workspaceItems.map((item) => <SidebarNavItem active={section === item.value} item={item} key={item.value} onNavigate={navigate} />)}
        </nav>

        <div className="sidebar-footer">
          <div className="observer-state"><span className={`live-dot${data.mode === "LIVE" ? "" : " live-dot-muted"}`} /><span><strong>{data.mode === "LIVE" ? "Neon connected" : "Live data unavailable"}</strong><small>{data.mode === "LIVE" ? "Tenant-scoped records" : "Server configuration required"}</small></span></div>
          <div className="user-row"><span className="user-avatar">R</span><span><strong>Rob</strong><small>Decision maker</small></span><span className="user-more">•••</span></div>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{section[0].toUpperCase() + section.slice(1)}</strong></div>
          <div className="topbar-actions"><span className="last-updated"><span className="refresh-icon">↻</span> {data.mode === "LIVE" ? "Loaded from Neon" : "Awaiting live data"}</span><button className="help-button" type="button" aria-label="Help">?</button><button className="top-avatar" type="button" aria-label="Open profile">R</button></div>
        </header>

        <div className="dashboard-content">
          <div className={`preview-banner${data.mode === "LIVE" ? " live-banner" : " unavailable-banner"}`}><span className="preview-pulse" /><span><strong>{data.mode === "LIVE" ? "Live data" : "Live data unavailable"}</strong> {data.notice}</span><span className="banner-model">OpenRouter · Luna 5.6</span></div>

          <div className="section-view" id={section}>
            {section === "overview" && <OverviewView data={data} metrics={metrics} onDecisionFilter={() => { setFilter("needs-human"); navigate("conversations"); }} conversationWorkspace={conversationWorkspace} />}
            {section === "conversations" && conversationWorkspace}
            {section === "decisions" && <DecisionsView conversations={data.conversations} onOpenConversation={openConversation} />}
            {section === "activity" && <ActivityView conversations={data.conversations} />}
            {section === "sources" && <SourcesView connectors={data.connectors} onOpenSettings={() => navigate("settings")} />}
            {section === "settings" && <SettingsView connectors={data.connectors} />}
          </div>

          <footer className="dashboard-footer"><span><span className="footer-check">✓</span> Read-only intelligence layer</span><span>Tenant scoped · No automatic writes</span><span className="footer-model">Model <strong>openai/gpt-5.6-luna</strong></span></footer>
        </div>
      </main>
    </div>
  );
}
