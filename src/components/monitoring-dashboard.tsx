"use client";

import { useMemo, useState } from "react";
import {
  filterConversations,
  getMonitoringMetrics,
  type ConversationFilter,
  type MonitoredConversation,
  type MonitoringDashboardData,
  type SourceFilter,
} from "../lib/monitoring";

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
                <span className="preview-ref">Preview</span>
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

export function MonitoringDashboard({ data }: { data: MonitoringDashboardData }) {
  const [filter, setFilter] = useState<ConversationFilter>("open");
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(data.conversations[0]?.id ?? null);
  const metrics = useMemo(() => getMonitoringMetrics(data.conversations), [data.conversations]);
  const filteredConversations = useMemo(() => {
    const byStatus = filterConversations(data.conversations, filter);
    return source === "all" ? filterConversations(byStatus, "all", query) : filterConversations(byStatus, source, query);
  }, [data.conversations, filter, query, source]);
  const selectedConversation = filteredConversations.find(({ id }) => id === selectedId) ?? filteredConversations[0] ?? null;

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">✦</div>
          <div><strong>Signal</strong><span>Conversation intelligence</span></div>
        </div>

        <div className="workspace-switcher">
          <span className="workspace-avatar">T</span>
          <span><strong>Talacha</strong><small>Operating room</small></span>
          <span className="workspace-chevron">⌄</span>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <a className="nav-item nav-item-active" href="#overview"><span className="nav-icon">◈</span>Overview</a>
          <a className="nav-item" href="#conversations"><span className="nav-icon">◌</span>Conversations<span className="nav-count">{metrics.open}</span></a>
          <a className="nav-item" href="#decisions"><span className="nav-icon">◇</span>Decisions<span className="nav-count nav-count-warm">{metrics.needsHuman}</span></a>
          <a className="nav-item" href="#activity"><span className="nav-icon">↗</span>Activity</a>
        </nav>

        <div className="sidebar-rule" />
        <div className="sidebar-label">Workspace</div>
        <nav className="secondary-nav" aria-label="Workspace navigation">
          <a className="nav-item" href="#sources"><span className="nav-icon">⌁</span>Sources</a>
          <a className="nav-item" href="#settings"><span className="nav-icon">⚙</span>Settings</a>
        </nav>

        <div className="sidebar-footer">
          <div className="observer-state"><span className="live-dot" /><span><strong>Observer active</strong><small>Listening for signal</small></span></div>
          <div className="user-row"><span className="user-avatar">R</span><span><strong>Rob</strong><small>Decision maker</small></span><span className="user-more">•••</span></div>
        </div>
      </aside>

      <main className="dashboard-main" id="overview">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span>/</span><strong>Overview</strong></div>
          <div className="topbar-actions"><span className="last-updated"><span className="refresh-icon">↻</span> Updated just now</span><button className="help-button" type="button" aria-label="Help">?</button><button className="top-avatar" type="button" aria-label="Open profile">R</button></div>
        </header>

        <div className="dashboard-content">
          <div className="preview-banner"><span className="preview-pulse" /><span><strong>Preview mode</strong> Synthetic records are shown until the passive Slack and GitHub observer is connected.</span><span className="banner-model">OpenRouter · Luna 5.6</span></div>

          <section className="page-heading">
            <div><p className="eyebrow">Executive operating room</p><h1>Know what needs a human.</h1><p className="page-subtitle">Signal listens across the conversations your team already has and surfaces only the decisions, risks, and owner gaps worth your attention.</p></div>
            <div className="heading-status"><span className="observer-orbit"><span /></span><div><strong>Passive observer</strong><span>Slack + GitHub PRs</span></div></div>
          </section>

          <section className="metric-grid" aria-label="Monitoring summary">
            <div className="metric-card metric-card-primary"><span className="metric-label">Open conversations</span><strong>{metrics.open}</strong><span className="metric-foot"><span className="metric-trend">↑ 12%</span> vs. yesterday</span><span className="metric-watermark">◌</span></div>
            <div className="metric-card"><span className="metric-label">Needs your call</span><strong>{metrics.needsHuman}</strong><span className="metric-foot">Human input has leverage</span><span className="metric-spark">▁▃▂▅▃▆</span></div>
            <div className="metric-card"><span className="metric-label">Signal sources</span><strong>{metrics.slack + metrics.github}</strong><span className="metric-foot"><span className="source-mini source-mini-slack">S</span> Slack <span className="source-mini source-mini-github">⌘</span> GitHub PRs</span></div>
            <div className="metric-card"><span className="metric-label">Noise filtered</span><strong>84<span className="metric-unit">%</span></strong><span className="metric-foot">Deterministic + agent triage</span><span className="noise-ring">84</span></div>
          </section>

          <section className="attention-card">
            <div className="attention-accent" />
            <div className="attention-icon">!</div>
            <div className="attention-copy"><div className="attention-overline">Top signal · {data.conversations.filter(({ priority }) => priority === "high").length} high-value threads</div><h2>{data.conversations.find(({ status }) => status === "needs-human")?.title ?? "No open decision gaps"}</h2><p>{data.conversations.find(({ status }) => status === "needs-human")?.summary ?? "Signal is monitoring the workspace for meaningful changes."}</p></div>
            <button className="attention-action" type="button" onClick={() => setFilter("needs-human")}>See decision gaps <span aria-hidden="true">→</span></button>
          </section>

          <section className="monitoring-workspace" id="conversations">
            <div className="conversation-column">
              <div className="section-title-row"><div><p className="eyebrow">Live queue</p><h2>Open conversations</h2></div><span className="queue-count">{filteredConversations.length} showing</span></div>
              <div className="toolbar">
                <div className="filter-tabs" role="group" aria-label="Conversation status">
                  {filterOptions.map((option) => <button className={filter === option.value ? "filter-tab filter-tab-active" : "filter-tab"} key={option.value} onClick={() => setFilter(option.value)} type="button" aria-pressed={filter === option.value}>{option.label}</button>)}
                </div>
                <label className="search-field"><span aria-hidden="true">⌕</span><span className="sr-only">Search conversations</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search" type="search" value={query} /></label>
              </div>
              <div className="source-tabs" role="group" aria-label="Conversation source">
                {sourceOptions.map((option) => <button className={source === option.value ? "source-tab source-tab-active" : "source-tab"} key={option.value} onClick={() => setSource(option.value)} type="button" aria-pressed={source === option.value}>{option.label}</button>)}
              </div>
              <div className="conversation-list">
                {filteredConversations.length ? filteredConversations.map((conversation) => <ConversationCard conversation={conversation} key={conversation.id} onSelect={() => setSelectedId(conversation.id)} selected={conversation.id === selectedConversation?.id} />) : <div className="list-empty"><span>⌕</span><strong>Nothing here yet</strong><p>Signal will bring a conversation here when it finds a meaningful change.</p></div>}
              </div>
            </div>
            <DetailPanel conversation={selectedConversation} />
          </section>

          <footer className="dashboard-footer"><span><span className="footer-check">✓</span> Read-only intelligence layer</span><span>Tenant scoped · No automatic writes</span><span className="footer-model">Model <strong>openai/gpt-5.6-luna</strong></span></footer>
        </div>
      </main>
    </div>
  );
}
