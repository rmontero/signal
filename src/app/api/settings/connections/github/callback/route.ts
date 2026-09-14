import { handleGitHubConnectionRoute } from "@/services/github-connection";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleGitHubConnectionRoute(request, "callback");
}
