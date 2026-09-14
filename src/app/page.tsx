import { MonitoringDashboard } from "../components/monitoring-dashboard";
import { loadMonitoringDashboardData } from "../lib/monitoring-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  // The default loader resolves Auth0 membership on the server for every refresh.
  // Page/search/header inputs cannot supply tenant authority.
  const data = await loadMonitoringDashboardData();
  return <MonitoringDashboard data={data} />;
}
