import { MonitoringDashboard } from "../components/monitoring-dashboard";
import { CURRENT_MONITORING_DATA } from "../lib/monitoring";

export default function Home() {
  return <MonitoringDashboard data={CURRENT_MONITORING_DATA} />;
}
