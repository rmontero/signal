import { MonitoringDashboard } from "../components/monitoring-dashboard";
import { loadMonitoringDashboardData } from "../lib/monitoring-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await loadMonitoringDashboardData();
  return <MonitoringDashboard data={data} />;
}
