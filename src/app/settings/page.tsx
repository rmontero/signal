import { redirect } from "next/navigation.js";
import Link from "next/link.js";
import { SettingsConnections, type ConnectionNotice } from "../../components/settings-connections";
import { resolveViewerTenant } from "../../lib/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Page inputs cannot supply tenant authority. The read API rechecks membership
  // on every load; neither this subject nor its tenant is serialized to React.
  if (!await resolveViewerTenant()) redirect("/auth/login?returnTo=%2Fsettings");
  const query = await searchParams;
  let notice: ConnectionNotice | undefined;
  if (query.slack === "error") notice = "error";
  else if (query.slack === "cancelled") notice = "cancelled";
  else if (query.github === "connected" || query.slack === "connected") notice = "returned";
  // These browser-editable flags never assert successful enrollment/connection.
  return (
    <main className="connection-settings-page">
      <nav className="connection-settings-nav" aria-label="Settings navigation">
        <Link href="/" prefetch={false}>← Back to dashboard</Link><a href="/auth/logout">Sign out</a>
      </nav>
      <header className="connection-settings-heading">
        <p className="eyebrow">Signal workspace</p>
        <h1>Settings</h1>
        <p>Manage the GitHub and Slack connections for your workspace.</p>
      </header>
      <SettingsConnections notice={notice} />
    </main>
  );
}
