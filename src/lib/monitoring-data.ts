import { createDb } from "../db/client";
import { listMonitoringConversations, listObservedConversations } from "../db/repositories";
import { getConnectorStatuses, type ConnectorEnvironment } from "./dashboard-settings";
import { mapObservedConversation, mapPersistedConversation, type MonitoringDashboardData } from "./monitoring";

export async function loadMonitoringDashboardData(): Promise<MonitoringDashboardData> {
  const connectors = getConnectorStatuses(process.env as ConnectorEnvironment);
  const tenantId = process.env.SIGNAL_DASHBOARD_TENANT_ID?.trim();
  if (!tenantId) {
    return {
      mode: "UNAVAILABLE",
      notice: "Live data is unavailable until SIGNAL_DASHBOARD_TENANT_ID is configured on the server.",
      conversations: [],
      connectors,
    };
  }

  if (!process.env.DATABASE_URL) {
    return {
      mode: "UNAVAILABLE",
      notice: "Live data is unavailable until the Neon DATABASE_URL is configured on the server.",
      conversations: [],
      connectors,
    };
  }

  const { db, pool } = createDb();
  try {
    const [rows, observedRows] = await Promise.all([listMonitoringConversations(db, tenantId), listObservedConversations(db, tenantId)]);
    return {
      mode: "LIVE",
      notice: "Showing tenant-scoped conversations and observer events persisted in Neon. Classification is read-only until a human acts.",
      conversations: [...rows.map(mapPersistedConversation), ...observedRows.map(mapObservedConversation)],
      connectors,
    };
  } catch {
    return {
      mode: "UNAVAILABLE",
      notice: "Live data could not be loaded from Neon. Check the server configuration and database connectivity.",
      conversations: [],
      connectors,
    };
  } finally {
    await pool.end();
  }
}
