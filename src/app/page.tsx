import { MonitoringDashboard } from "../components/monitoring-dashboard";
import { loadMonitoringDashboardData } from "../lib/monitoring-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  // The default loader denies private reads until verified session-to-tenant
  // admission is implemented. Page/search/header inputs cannot supply authority.
  const data = await loadMonitoringDashboardData();
  return <MonitoringDashboard data={data} />;
}
