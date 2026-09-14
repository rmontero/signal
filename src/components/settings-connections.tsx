"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Provider = "github" | "slack";
export type SafeConnectionSummary = {
  provider: Provider; displayName: string | null; externalIdSuffix: string | null;
  scopes: string[]; status: "ACTIVE" | "REVOKED";
  createdAt: string; updatedAt: string; revokedAt: string | null;
};
export type SettingsSnapshot = { connections: SafeConnectionSummary[]; canManage: boolean; setup: Record<Provider, boolean> };
export type ConnectionNotice = "returned" | "cancelled" | "error";
const providers = ["github", "slack"] as const;
const names = { github: "GitHub", slack: "Slack" };
const scopes = {
  github: ["issues:write", "metadata:read", "pull_requests:read", "pull_requests:write"],
  slack: ["app_mentions:read", "channels:history", "channels:read", "chat:write", "groups:history", "groups:read"],
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

/** Select only the public DTO fields. Malformed responses never become UI text. */
export function parseConnectionSnapshot(value: unknown): SettingsSnapshot {
  if (!isRecord(value) || !Array.isArray(value.connections) || value.connections.length > 2 || typeof value.canManage !== "boolean"
    || !isRecord(value.setup) || typeof value.setup.github !== "boolean" || typeof value.setup.slack !== "boolean") throw new Error("Connections are unavailable.");
  const connections = value.connections.map((row): SafeConnectionSummary => {
    if (!isRecord(row) || (row.provider !== "github" && row.provider !== "slack") || (row.status !== "ACTIVE" && row.status !== "REVOKED")
      || (row.displayName !== null && (typeof row.displayName !== "string" || !row.displayName || row.displayName.length > 120
        || /[\p{Cc}\p{Cf}<>]/u.test(row.displayName) || /xox[baprs]-|gh[pousr]_|github_pat_|-----BEGIN|eyJ[\w-]*\.|auth0\|/i.test(row.displayName)))
      || (row.externalIdSuffix !== null && (typeof row.externalIdSuffix !== "string" || !/^[A-Z0-9]{4}$/.test(row.externalIdSuffix)))
      || !Array.isArray(row.scopes) || row.scopes.length > 10 || !row.scopes.every((scope) => typeof scope === "string" && scopes[row.provider as Provider].includes(scope))
      || !isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt) || (row.revokedAt !== null && !isTimestamp(row.revokedAt))
      || (row.status === "REVOKED") !== (row.revokedAt !== null)) throw new Error("Connections are unavailable.");
    return { provider: row.provider, status: row.status, displayName: row.displayName as string | null, externalIdSuffix: row.externalIdSuffix as string | null,
      scopes: [...new Set(row.scopes as string[])].sort(), createdAt: row.createdAt, updatedAt: row.updatedAt, revokedAt: row.revokedAt as string | null };
  });
  if (new Set(connections.map(({ provider }) => provider)).size !== connections.length) throw new Error("Connections are unavailable.");
  return { connections, canManage: value.canManage, setup: { github: value.setup.github, slack: value.setup.slack } };
}

async function readSnapshot(signal?: AbortSignal): Promise<SettingsSnapshot> {
  const response = await fetch("/api/settings/connections", { credentials: "same-origin", cache: "no-store", redirect: "error", signal: signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Connections are unavailable.");
  return parseConnectionSnapshot(await response.json());
}

function ConnectionTime({ value }: { value: string }) {
  return <time dateTime={value}>{value.replace("T", " ").slice(0, 19)} UTC</time>;
}

function ConnectionCard({ provider, connection, canManage, setupReady, onRevoke }: {
  provider: Provider; connection?: SafeConnectionSummary; canManage: boolean; setupReady: boolean; onRevoke: (provider: Provider) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = names[provider];
  const active = connection?.status === "ACTIVE";
  function cancel() { setConfirming(false); setConfirmed(false); trigger.current?.focus(); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (confirmed && canManage) void onRevoke(provider);
  }
  return (
    <article className="connector-card connection-card" aria-labelledby={`connection-${provider}`}>
      <div className="connector-card-header">
        <span className={`connector-logo connector-logo-${provider}`} aria-hidden="true">{provider === "github" ? "⌘" : "S"}</span>
        <div className="connector-card-title"><h2 id={`connection-${provider}`}>{name}</h2></div>
        <span className={`connection-state connection-state-${active ? "saved" : "disconnected"}`}>{active ? "Connection saved" : connection ? "Disconnected" : "Not connected"}</span>
      </div>
      {connection && <>
        <p className="connection-display-name">{connection.displayName ?? "Account details unavailable"}</p>
        <dl className="connection-metadata">
          {connection.externalIdSuffix && <div><dt>Account ID ending in</dt><dd>…{connection.externalIdSuffix}</dd></div>}
          <div><dt>Scopes</dt><dd>{connection.scopes.length ? <ul className="connection-scopes">{connection.scopes.map((scope) => <li key={scope}><code>{scope}</code></li>)}</ul> : "No scopes recorded"}</dd></div>
          <div><dt>Created</dt><dd><ConnectionTime value={connection.createdAt} /></dd></div>
          <div><dt>Updated</dt><dd><ConnectionTime value={connection.updatedAt} /></dd></div>
          {connection.revokedAt && <div><dt>Disconnected</dt><dd><ConnectionTime value={connection.revokedAt} /></dd></div>}
        </dl>
      </>}
      <p className="connection-guidance" id={`connection-help-${provider}`}>
        {provider === "github"
          ? "Trusted GitHub installation enrollment may be required before connecting. Ask your workspace administrator to confirm the installation and repository/channel mapping."
          : "Connecting a Slack workspace saves its connection. An administrator must confirm repository/channel mapping and verify event delivery separately."}
      </p>
      {canManage && <div className="connection-actions">
        {!confirming && (setupReady ? <a className="connection-button" href={`/api/settings/connections/${provider}/start?returnTo=%2Fsettings`} aria-describedby={`connection-help-${provider}`}>{active || connection ? "Reconnect" : "Connect"} {name}</a>
          : <p className="connection-setup-unavailable">Connection setup is unavailable. Ask your administrator to check configuration.</p>)}
        {active && <button className="connection-button connection-button-danger" ref={trigger} type="button" aria-expanded={confirming} aria-controls={confirming ? `confirm-${provider}` : undefined} onClick={() => setConfirming(true)}>Disconnect {name}</button>}
      </div>}
      {canManage && confirming && <form className="connection-confirmation" id={`confirm-${provider}`} onSubmit={submit}>
        <fieldset>
          <legend>Disconnect {name} from Signal?</legend>
          <p>This disables dependent channel mappings and cancels pending connection callbacks. Audit and replay records are retained. The app installation at {name} is managed separately.</p>
          <label><input ref={(node) => { node?.focus(); }} type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I understand that dependent mappings will be disabled.</label>
          <div className="connection-actions"><button className="connection-button connection-button-danger" type="submit" disabled={!confirmed}>Confirm disconnect</button><button className="connection-button" type="button" onClick={cancel}>Cancel</button></div>
        </fieldset>
      </form>}
    </article>
  );
}

export function SettingsConnections({ initialSnapshot, notice }: { initialSnapshot?: SettingsSnapshot; notice?: ConnectionNotice }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(() => initialSnapshot ? parseConnectionSnapshot(initialSnapshot) : null);
  const [pending, setPending] = useState<string | null>(initialSnapshot ? null : "Loading connections…");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(!initialSnapshot);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!pending && restoreFocus.current) {
      refreshButton.current?.focus();
      restoreFocus.current = false;
    }
  }, [pending]);

  useEffect(() => {
    if (initialSnapshot) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let current = true;
    readSnapshot(controller.signal).then((data) => { if (current) setSnapshot(data); }).catch(() => {
      if (current) { setSnapshot(null); setError("Connections are unavailable. Sign in again or contact your workspace administrator."); }
    }).finally(() => { if (current) { setPending(null); busy.current = false; } clearTimeout(timeout); });
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [initialSnapshot]);

  async function refresh() {
    if (busy.current) return;
    busy.current = true; setSnapshot(null); setError(null); setMessage(null); setPending("Loading connections…");
    try { setSnapshot(await readSnapshot()); }
    catch { setError("Connections are unavailable. Sign in again or contact your workspace administrator."); }
    finally { setPending(null); busy.current = false; }
  }

  async function revoke(provider: Provider) {
    if (busy.current || !snapshot?.canManage) return;
    restoreFocus.current = true;
    busy.current = true; setSnapshot(null); setError(null); setMessage(null); setPending(`Disconnecting ${names[provider]}…`);
    try {
      const response = await fetch(`/api/settings/connections/${provider}/revoke`, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || (await response.json())?.status !== "revoked") throw new Error();
      setSnapshot(await readSnapshot());
      setMessage("Connection disconnected in Signal. Dependent mappings are disabled.");
    } catch { setError("We couldn’t confirm the change. Refresh connection status before trying again."); }
    finally { setPending(null); busy.current = false; }
  }

  const notices = {
    returned: "Returned from provider setup. The status below is loaded from Signal.",
    cancelled: "Slack setup was cancelled. The status below is loaded from Signal.",
    error: "Slack setup could not be completed. Check the current status or contact your administrator.",
  };
  return (
    <section className="settings-connections" aria-label="Workspace connections" aria-busy={!!pending}>
      <div className="settings-callout"><div className="settings-callout-icon" aria-hidden="true">⚙</div><div><strong>Workspace connections</strong><p>A saved connection does not verify live delivery. Repository/channel mapping and runtime activation require administrator setup. GitHub actions still require named approval in Slack.</p></div></div>
      {notice && <p className="connection-notice" role={notice === "error" ? "alert" : "status"}>{notices[notice]}</p>}
      <div className="connection-toolbar"><p>GitHub and Slack</p><button className="connection-button" ref={refreshButton} type="button" disabled={!!pending} onClick={() => void refresh()}>Refresh connections</button></div>
      <div role="status" aria-live="polite">{pending && <p className="connection-notice">{pending}</p>}{message && <p className="connection-notice">{message}</p>}</div>
      {error && <div className="connection-error" role="alert"><p>{error}</p><a href="/auth/login?returnTo=%2Fsettings">Sign in again</a></div>}
      {snapshot && <>
        {!snapshot.canManage && <p className="connection-notice">Only workspace owners and administrators can connect or disconnect providers.</p>}
        <div className="connector-grid">{providers.map((provider) => <ConnectionCard key={provider} provider={provider} connection={snapshot.connections.find((row) => row.provider === provider)} canManage={snapshot.canManage} setupReady={snapshot.setup[provider]} onRevoke={revoke} />)}</div>
      </>}
    </section>
  );
}
