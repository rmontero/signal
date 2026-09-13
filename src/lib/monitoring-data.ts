import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { listMonitoringConversations, listObservedConversations } from "../db/repositories";
import { channelMappings, tenants } from "../db/schema";
import { getConnectorStatuses, type ConnectorEnvironment } from "./dashboard-settings";
import { mapObservedConversation, mapPersistedConversation, type MonitoringDashboardData } from "./monitoring";

type PilotMapping = Pick<typeof channelMappings.$inferSelect, "channelId" | "repositoryId" | "repositoryOwner" | "repositoryName">;

async function loadConfiguredPilot(db: ReturnType<typeof createDb>["db"], tenantId: string): Promise<PilotMapping[] | null> {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, tenantId), eq(tenants.active, true))).limit(1);
  if (!tenant) return null;
  return db.select({ channelId: channelMappings.channelId, repositoryId: channelMappings.repositoryId, repositoryOwner: channelMappings.repositoryOwner, repositoryName: channelMappings.repositoryName })
    .from(channelMappings).where(and(eq(channelMappings.tenantId, tenantId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false)));
}

const defaultDependencies = {
  createDb,
  loadConfiguredPilot,
  listMonitoringConversations,
  listObservedConversations,
};

type MonitoringDependencies = typeof defaultDependencies & {
  // Trusted server composition only: verify the session, then resolve its subject's
  // tenant mapping. Never implement this from a header, query, browser ID or env ID.
  // Auth0 is incomplete, so production deliberately provides no resolver yet.
  resolveViewer?: () => Promise<{ subject: string; tenantId: string | null } | null>;
};

// Not a Server Action or HTTP API. The optional function dependency is for isolated
// server tests; the public page uses the default, which cannot read private records.
export async function loadMonitoringDashboardData(dependencies: MonitoringDependencies = defaultDependencies): Promise<MonitoringDashboardData> {
  const connectors = getConnectorStatuses(process.env as ConnectorEnvironment);
  const tenantId = process.env.SIGNAL_DASHBOARD_TENANT_ID?.trim();
  const unavailable = (notice: string): MonitoringDashboardData => ({ mode: "UNAVAILABLE", notice, conversations: [], connectors });
  if (typeof window !== "undefined" || typeof dependencies.resolveViewer !== "function") {
    return unavailable("Private monitoring is unavailable: viewer authentication is not configured. The optional Auth0 inspector is disabled or incomplete. This public setup shell does not load private records; configuring a pilot tenant alone does not grant access.");
  }

  // Resolve and validate authority before even constructing a DB connection. Use
  // one generic denial for anonymous, unmapped, mismatched and failed resolutions.
  const viewerDenied = () => unavailable("Private monitoring is unavailable for this viewer. A verified server session mapped to the configured pilot is required. No private records were loaded.");
  try {
    const viewer = await dependencies.resolveViewer();
    if (!viewer || typeof viewer.subject !== "string" || !viewer.subject.trim() || typeof viewer.tenantId !== "string" || !viewer.tenantId || viewer.tenantId !== tenantId) {
      return viewerDenied();
    }
  } catch {
    return viewerDenied();
  }

  if (!tenantId) {
    return unavailable("Configure SIGNAL_DASHBOARD_TENANT_ID on the server to select the pilot. No monitoring records have been loaded.");
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return unavailable("Configure the Neon DATABASE_URL on the server. No monitoring records have been loaded.");
  }

  let connection: ReturnType<typeof createDb> | undefined;
  try {
    connection = dependencies.createDb();
    const { db } = connection;
    const mappings = await dependencies.loadConfiguredPilot(db, tenantId);
    if (!mappings) return unavailable("The server-selected pilot tenant is missing or inactive. An operator must verify the pilot configuration.");
    if (!mappings.length) return unavailable("The selected pilot has no enabled, non-shared channel/repository mappings. An operator must import the pilot configuration before monitoring can be shown.");
    const [rows, observedRows] = await Promise.all([dependencies.listMonitoringConversations(db, tenantId), dependencies.listObservedConversations(db, tenantId)]);
    if ([...rows, ...observedRows].some((row) => row.tenantId !== tenantId)) return unavailable("The monitoring snapshot could not be verified for the configured pilot. An operator must inspect the server data scope.");
    const conversations = [
      ...rows.filter((row) => mappings.some((mapping) => mapping.channelId === row.channelId && mapping.repositoryOwner === row.repositoryOwner && mapping.repositoryName === row.repositoryName)).map((row) => mapPersistedConversation(row)),
      ...observedRows.filter((row) => mappings.some((mapping) => row.source === "slack"
        ? mapping.channelId === row.channelId
        : mapping.repositoryId === row.repositoryId && mapping.repositoryOwner === row.repositoryOwner && mapping.repositoryName === row.repositoryName)).map(mapObservedConversation),
    ].sort((a, b) => b.activityTimestamp.localeCompare(a.activityTimestamp) || a.id.localeCompare(b.id));
    return {
      mode: "LIVE",
      loadedAt: new Date().toISOString(),
      notice: conversations.length
        ? "Showing persisted records for the server-configured pilot. This snapshot does not verify current feed health. Refresh to check for changes. GitHub actions still require named Slack approval."
        : "The configured pilot was read successfully, but no monitoring records are available. Feed delivery and worker execution are not verified by this empty snapshot.",
      conversations,
      connectors,
    };
  } catch {
    return unavailable("Monitoring records could not be loaded. Check the server's database configuration, schema and connectivity; feed health is unknown.");
  } finally {
    // Cleanup failures must not expose connection strings or replace the sanitized result.
    if (connection) await connection.pool.end().catch(() => undefined);
  }
}
