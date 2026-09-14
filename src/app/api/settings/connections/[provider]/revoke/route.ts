import { revokeSettingsConnection } from "./handler";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  return revokeSettingsConnection(request, (await params).provider);
}
