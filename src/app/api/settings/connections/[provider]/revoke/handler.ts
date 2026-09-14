import "server-only";
import { eq } from "drizzle-orm";
import { createDb, type SignalDb } from "@/db/client";
import { createConnectionRepository, type ConnectionProvider } from "@/db/connection-repository";
import { requireTenantAdmin } from "@/db/membership-repository";
import { providerConnections } from "@/db/schema";
import { readAuth0Settings } from "@/lib/auth0";
import { resolveViewerTenant, type ViewerTenant } from "@/lib/tenant-context";
import { readGitHubConnectionSettings } from "@/services/github-connection";
import { readSlackConnectionSettings } from "@/services/slack-connection";
import { SLACK_CONNECTION_SCOPES } from "@/adapters/slack-api";
import type { SafeConnectionSummary, SettingsSnapshot } from "@/components/settings-connections";

// Shared server composition for the Settings read/revoke routes. No Server
// Actions or client-callable tenant selectors; route files export only handlers.
const unavailable = "Connections are unavailable.";
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const isProvider = (value: unknown): value is ConnectionProvider => value === "github" || value === "slack";
const sameViewer = (a: ViewerTenant | null, b: ViewerTenant) => a?.subject === b.subject && a?.tenantId === b.tenantId && a?.role === b.role;
class SettingsError extends Error {
  constructor(readonly status: number) { super(unavailable); }
}
const response = (body: object, status = 200) => Response.json(body, { status, headers });
const failure = (error: unknown) => response({ status: "unavailable" }, error instanceof SettingsError ? error.status : 503);

async function withDatabase<T>(work: (db: SignalDb) => Promise<T>): Promise<T> {
  let connection: ReturnType<typeof createDb> | undefined;
  try { connection = createDb(); return await work(connection.db); }
  finally { try { await connection?.pool.end(); } catch { /* Driver details are private. */ } }
}

async function viewer(): Promise<ViewerTenant> {
  const current = await resolveViewerTenant();
  if (!current) throw new SettingsError(401);
  return current;
}

function safeName(value: string, authority: ViewerTenant): string | null {
  if (!value || value !== value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}<>]/u.test(value)
    || /xox[baprs]-|gh[pousr]_|github_pat_|-----BEGIN|eyJ[\w-]*\.|auth0\|/i.test(value)
    || value.includes(authority.subject) || value.includes(authority.tenantId)) return null;
  return value;
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error();
  return value.toISOString();
}

/** Server-only. A supplied viewer must match a fresh verified membership. */
export async function listTenantConnections(authority: ViewerTenant): Promise<SafeConnectionSummary[]> {
  try {
    if (!sameViewer(await resolveViewerTenant(), authority)) throw new Error();
    return await withDatabase(async (db) => {
      // Never select credentials, raw payloads, installation IDs or bot IDs.
      const rows = await db.select({
        tenantId: providerConnections.tenantId, provider: providerConnections.provider,
        externalAccountId: providerConnections.externalAccountId, displayName: providerConnections.displayName,
        scopes: providerConnections.scopes, status: providerConnections.status,
        createdAt: providerConnections.createdAt, updatedAt: providerConnections.updatedAt, revokedAt: providerConnections.revokedAt,
      }).from(providerConnections).where(eq(providerConnections.tenantId, authority.tenantId)).limit(3);
      if (rows.length > 2 || new Set(rows.map((row) => row.provider)).size !== rows.length) throw new Error();
      return rows.map((row) => {
        if (row.tenantId !== authority.tenantId || !isProvider(row.provider) || !["ACTIVE", "REVOKED"].includes(row.status)
          || !Array.isArray(row.scopes) || row.scopes.length > 100 || typeof row.displayName !== "string"
          || (row.status === "REVOKED") !== (row.revokedAt !== null)) throw new Error();
        const allowedScopes = row.provider === "github" ? ["issues:write", "metadata:read", "pull_requests:read", "pull_requests:write"] : SLACK_CONNECTION_SCOPES;
        const safeId = typeof row.externalAccountId === "string" && (row.provider === "github" ? /^[1-9]\d{7,31}$/ : /^T[A-Z0-9]{7,63}$/).test(row.externalAccountId);
        return {
          provider: row.provider, displayName: safeName(row.displayName, authority),
          externalIdSuffix: safeId ? row.externalAccountId.slice(-4) : null,
          scopes: [...new Set(row.scopes.filter((scope) => allowedScopes.includes(scope)))].sort(), status: row.status,
          createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt), revokedAt: row.revokedAt === null ? null : timestamp(row.revokedAt),
        };
      });
    });
  } catch {
    // SQL and provider-setting errors may include secret parameters/causes.
    throw new Error(unavailable);
  }
}

function setupAvailability(): SettingsSnapshot["setup"] {
  const setup = { github: false, slack: false };
  if (!/^[a-f\d]{64}$/i.test(process.env.CONNECTIONS_ENCRYPTION_KEY ?? "")) return setup;
  try { readGitHubConnectionSettings(); setup.github = true; } catch { /* Unconfigured. */ }
  try { readSlackConnectionSettings(); setup.slack = true; } catch { /* Unconfigured. */ }
  // Configuration only. GitHub's existing start route still requires its
  // trusted installation binding (B-T5-01); no enrollment is invented here.
  return setup;
}

export async function getSettingsConnections(request: Request): Promise<Response> {
  try {
    const authority = await viewer();
    if (new URL(request.url).search) throw new SettingsError(400);
    const connections = await listTenantConnections(authority);
    return response({ connections, canManage: authority.role === "OWNER" || authority.role === "ADMIN", setup: setupAvailability() } satisfies SettingsSnapshot);
  } catch (error) { return failure(error); }
}

async function requireConfirmation(request: Request): Promise<void> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || Number(request.headers.get("content-length") ?? 0) > 1024 || !request.body) throw new SettingsError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) throw new Error();
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length !== 1 || body.confirm !== true) throw new Error();
  } catch { throw new SettingsError(400); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function revokeSettingsConnection(request: Request, provider: string): Promise<Response> {
  try {
    const authority = await viewer();
    try { requireTenantAdmin(authority); } catch { throw new SettingsError(403); }
    if (request.method !== "POST" || !isProvider(provider) || new URL(request.url).search) throw new SettingsError(400);
    // JSON alone is insufficient for CSRF. Trust the configured app origin,
    // never a browser/proxy Host or X-Forwarded-Host value.
    if (request.headers.get("origin") !== readAuth0Settings().appBaseUrl
      || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) throw new SettingsError(403);
    await requireConfirmation(request);
    const repository = createConnectionRepository({
      resolveViewerTenant: async () => {
        const current = await resolveViewerTenant();
        return sameViewer(current, authority) ? current : null;
      },
      getEncryptionKey: () => process.env.CONNECTIONS_ENCRYPTION_KEY ?? "",
    });
    const revoked = await withDatabase((db) => repository.revokeProviderConnection(db, { provider }));
    if (revoked.status !== "REVOKED") throw new Error();
    // Local disconnection, including mapping disablement and callback fencing.
    // Do not serialize even the repository's wider safe summary.
    return response({ status: "revoked" });
  } catch (error) { return failure(error); }
}
