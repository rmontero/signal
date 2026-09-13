import { NextResponse } from "next/server.js";
import { createDb } from "../../../db/client";
import { findMembershipBySubject } from "../../../db/membership-repository";
import { createAuth0Client, finishAuth0Callback, normalizeAuth0Subject, readAuth0Settings } from "../../../lib/auth0";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function protect(response: NextResponse): NextResponse {
  if (response.status >= 400) {
    response = new NextResponse("Authentication is unavailable.", { status: response.status, headers: response.headers });
    response.headers.delete("content-length");
    response.headers.delete("location");
    response.headers.set("content-type", "text/plain; charset=utf-8");
  }
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

let client: ReturnType<typeof createAuth0Client> | undefined;

export async function GET(request: Request) {
  try {
    const { appBaseUrl } = readAuth0Settings();
    client ??= createAuth0Client({ onCallback: async (error, context, session) => {
      // This hook runs after SDK transaction/token verification. The incoming
      // callback's query, email and any pre-existing browser session are not identity.
      const subject = normalizeAuth0Subject(session?.user?.sub);
      if (error || !subject) return finishAuth0Callback(error, context, session);
      let connection: ReturnType<typeof createDb> | undefined;
      try {
        connection = createDb();
        const membership = await findMembershipBySubject(connection.db, subject);
        if (membership && (!membership.active || !membership.tenantActive)) return protect(new NextResponse(null, { status: 403 }));
        return await finishAuth0Callback(null, { ...context, returnTo: membership ? context.returnTo : "/onboarding" }, session);
      } catch {
        return protect(new NextResponse(null, { status: 503 }));
      } finally {
        try { await connection?.pool.end(); } catch { /* Never disclose connection details. */ }
      }
    } });
    const url = new URL("/auth/callback", appBaseUrl);
    url.search = new URL(request.url).search;
    url.searchParams.delete("returnTo");
    // The SDK still creates the session and deletes its transaction cookie on
    // the hook's response, including sanitized membership-denial responses.
    return protect(await client.middleware(new Request(url, { headers: request.headers })));
  } catch {
    return protect(new NextResponse(null, { status: 503 }));
  }
}
