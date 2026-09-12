import { randomUUID, timingSafeEqual } from "node:crypto";
import { createDb } from "../../../../db/client";
import { cleanupRetention } from "../../../../db/repositories";
import { recoverOutbox } from "../../../../services/recover-outbox";

export const runtime = "nodejs";

function unauthorized(): Response {
  return Response.json({ error: { code: "unauthorized", requestId: randomUUID() } }, { status: 401 });
}

function sameSecret(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function hasValidBearer(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(expected && match && sameSecret(match[1].trim(), expected));
}

export async function GET(request: Request): Promise<Response> {
  if (!hasValidBearer(request)) return unauthorized();

  try {
    const { db, pool } = createDb();
    try {
      const cleanup = await cleanupRetention(db);
      const recovery = await recoverOutbox(db);
      return Response.json({ status: "ok", ...recovery, cleanup });
    } finally {
      await pool.end();
    }
  } catch {
    return Response.json({ error: { code: "maintenance_unavailable", requestId: randomUUID() } }, { status: 503 });
  }
}
