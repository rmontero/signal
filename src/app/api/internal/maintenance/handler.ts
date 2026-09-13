import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { cleanupRetention } from "../../../../db/repositories";
import type { recoverOutbox } from "../../../../services/recover-outbox";
import { RequestDeadline, type AfterResponse, type Connection } from "../../_lib/ingress";

export interface MaintenanceDependencies {
  cronSecret: () => string | undefined;
  createDb: () => Connection;
  cleanupRetention: typeof cleanupRetention;
  recoverOutbox: typeof recoverOutbox;
  after: AfterResponse;
  timeoutMs?: number;
}

function errorResponse(code: string, status: number): Response {
  return Response.json({ error: { code, requestId: randomUUID() } }, { status, headers: { "cache-control": "no-store" } });
}

function hasValidBearer(request: Request, expected: string | undefined): boolean {
  const match = /^Bearer +([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "");
  // Fixed-size digests avoid a secret-length-dependent comparison shortcut.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const equal = timingSafeEqual(digest(match?.[1] ?? ""), digest(expected ?? ""));
  return Boolean(expected && expected === expected.trim() && match && equal);
}

export function createMaintenanceHandler(dependencies: MaintenanceDependencies) {
  return async (request: Request): Promise<Response> => {
    if (!hasValidBearer(request, dependencies.cronSecret())) return errorResponse("unauthorized", 401);
    const deadline = new RequestDeadline(dependencies.timeoutMs ?? 10_000);
    let connection: Connection | undefined;
    try {
      connection = dependencies.createDb();
      const { db } = connection;
      const cleanup = await deadline.run(() => dependencies.cleanupRetention(db));
      const recovery = await deadline.run(() => dependencies.recoverOutbox(db, 20, { signal: deadline.signal, budgetMs: 8_000 }));
      const counts = { inspected: recovery.inspected, dispatched: recovery.dispatched, recoveryQueued: recovery.recoveryQueued, retried: recovery.retried, settled: recovery.settled, blocked: recovery.blocked };
      const cleaned = { snapshots: cleanup.snapshots, proposals: cleanup.proposals };
      if ([...Object.values(counts), ...Object.values(cleaned)].some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid maintenance counts");
      return Response.json({ status: "ok", ...counts, cleanup: cleaned }, { headers: { "cache-control": "no-store" } });
    } catch { return errorResponse("maintenance_unavailable", 503); }
    finally {
      deadline.close();
      if (connection) {
        const pool = connection.pool;
        const close = async () => { try { await pool.end(); } catch { /* No DB error disclosure. */ } };
        try { dependencies.after(close); } catch { void close(); }
      }
    }
  };
}
