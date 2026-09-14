import { handleSlackConnectionRoute } from "@/services/slack-connection";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleSlackConnectionRoute(request, "start");
}
