import { getSettingsConnections } from "./[provider]/revoke/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return getSettingsConnections(request);
}
