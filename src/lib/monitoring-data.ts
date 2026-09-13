import "server-only";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { listMonitoringConversations, listObservedConversations } from "../db/repositories";
import { channelMappings, tenants } from "../db/schema";
import { getConnectorStatuses, type ConnectorEnvironment } from "./dashboard-settings";
import { mapObservedConversation, mapPersistedConversation, type MonitoringDashboardData } from "./monitoring";
import { resolveViewerTenant } from "./tenant-context";

type PilotMapping = Pick<typeof channelMappings.$inferSelect, "channelId" | "repositoryId" | "repositoryOwner" | "repositoryName">;

async function loadConfiguredPilot(db: ReturnType<typeof createDb>["db"], tenantId: string): Promise<PilotMapping[] | null> {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, tenantId), eq(tenants.active, true))).limit(1);
  if (!tenant) return null;
  return db.select({ channelId: channelMappings.channelId, repositoryId: channelMappings.repositoryId, repositoryOwner: channelMappings.repositoryOwner, repositoryName: channelMappings.repositoryName })
    .from(channelMappings).where(and(eq(channelMappings.tenantId, tenantId), eq(channelMappings.enabled, true), eq(channelMappings.shared, false)));
}

const defaultDependencies = {
  resolveViewer: resolveViewerTenant,
  createDb,
  loadConfiguredPilot,
  listMonitoringConversations,
  listObservedConversations,
};

type MonitoringDependencies = Omit<typeof defaultDependencies, "resolveViewer"> & {
  // Trusted server composition only: verify the session, then resolve its subject's
  // tenant mapping. Never implement this from a header, query, browser ID or env ID.
  resolveViewer?: () => Promise<{ subject: string; tenantId: string | null } | null>;
};

// Not a Server Action or HTTP API. The optional function dependency is for isolated
// server tests; the page uses the Auth0-backed membership resolver by default.
export async function loadMonitoringDashboardData(dependencies: MonitoringDependencies = defaultDependencies): Promise<MonitoringDashboardData> {
  const connectors = getConnectorStatuses(process.env as ConnectorEnvironment);
  const unavailable = (notice: string): MonitoringDashboardData => ({ mode: "UNAVAILABLE", notice, conversations: [], connectors });
  const viewerDenied = () => unavailable("Private monitoring is unavailable for this viewer. A verified server session and an active tenant membership are required. No private records were loaded. Signing in does not configure providers or authorize GitHub actions.");
  if (typeof window !== "undefined" || typeof dependencies.resolveViewer !== "function") {
    return viewerDenied();
  }

  // Resolve membership before constructing the monitoring DB connection. Use one
  // generic denial for anonymous, unmapped, mismatched and failed resolutions.
  let tenantId: string;
  try {
    const viewer = await dependencies.resolveViewer();
    if (!viewer || typeof viewer.subject !== "string" || !/^[!-~]{1,255}$/.test(viewer.subject)
      || typeof viewer.tenantId !== "string" || !/^[!-~]{1,255}$/.test(viewer.tenantId)) {
      return viewerDenied();
    }
    tenantId = viewer.tenantId;
  } catch {
    return viewerDenied();
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return unavailable("Configure the Neon DATABASE_URL on the server. No monitoring records have been loaded.");
  }

  let connection: ReturnType<typeof createDb> | undefined;
  try {
    connection = dependencies.createDb();
    const { db } = connection;
    const mappings = await dependencies.loadConfiguredPilot(db, tenantId);
    if (!mappings) return unavailable("The workspace is unavailable or inactive. No monitoring records were loaded.");
    if (!mappings.length) return unavailable("The workspace has no enabled, non-shared channel/repository mappings. An operator must configure its mappings before monitoring can be shown. Signing in alone does not connect providers.");
    const [rows, observedRows] = await Promise.all([dependencies.listMonitoringConversations(db, tenantId), dependencies.listObservedConversations(db, tenantId)]);
    if ([...rows, ...observedRows].some((row) => row.tenantId !== tenantId)) return unavailable("The monitoring snapshot could not be verified for this workspace. An operator must inspect the server data scope.");
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
        ? "Showing persisted records for your authorized workspace. This snapshot does not verify current feed health. Refresh to check for changes. GitHub actions still require named Slack approval."
        : "The authorized workspace was read successfully, but no monitoring records are available. Feed delivery and worker execution are not verified by this empty snapshot.",
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
