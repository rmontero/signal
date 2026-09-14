import "server-only";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server.js";
import { exchangeSlackOAuthCode, SLACK_CONNECTION_SCOPES } from "../adapters/slack-api";
import { createDb, type SignalDb } from "../db/client";
import { revokeProviderConnection, upsertProviderConnection } from "../db/connection-repository";
import { requireTenantAdmin } from "../db/membership-repository";
import { providerConnections, tenants } from "../db/schema";
import { readAuth0Settings, validateReturnTo } from "../lib/auth0";
import { sealConnectionSecret } from "../lib/connection-crypto";
import { consumeOAuthState, createOAuthState, getOAuthStateAuthorization } from "../lib/oauth-state";
import { resolveViewerTenant, type ViewerTenant } from "../lib/tenant-context";

type Settings = { appBaseUrl: string; authorizationUrl: string; clientId: string; appId: string };
type ConnectionInput = Extract<Parameters<typeof upsertProviderConnection>[1], { provider: "slack" }>;
type CompletionInput = { state: string | null; code?: string | null; teamId?: string | null; error?: string | null };
type Result = { connectionId: string; teamId: string; botUserId: string; scopes: string[] };
export type SlackWorkspaceBinding = { teamId: string; botUserId?: string };
export interface SlackConnectionDependencies {
  resolveViewerTenant(): Promise<ViewerTenant | null>;
  getSettings(): Settings;
  getEncryptionKey(): string;
  loadBinding(viewer: ViewerTenant): Promise<SlackWorkspaceBinding | null>;
  createOAuthState: typeof createOAuthState;
  getOAuthStateAuthorization: typeof getOAuthStateAuthorization;
  consumeOAuthState: typeof consumeOAuthState;
  exchangeCode: typeof exchangeSlackOAuthCode;
  saveConnection(input: ConnectionInput): Promise<{ connectionId: string; externalAccountId: string; botUserId: string | null }>;
  revokeConnection(): Promise<{ connectionId: string; status: string }>;
}

const unavailable = "Slack connection is unavailable.";
const callbackPath = "/api/settings/connections/slack/callback";
const teamId = (value: unknown): value is string => typeof value === "string" && /^T[A-Z0-9]{1,63}$/.test(value);
const botUserId = (value: unknown): value is string => typeof value === "string" && /^[UW][A-Z0-9]{1,63}$/.test(value);
const protectedHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "content-type": "text/plain; charset=utf-8" };
class ConnectionError extends Error {
  constructor(readonly status: number) { super(unavailable); }
}

export function readSlackConnectionSettings(env: Record<string, string | undefined> = process.env): Settings {
  try {
    const { appBaseUrl } = readAuth0Settings(env);
    const base = new URL(appBaseUrl);
    // Slack treats localhost PKCE as a desktop flow, which cannot grant bot scopes.
    if (base.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error();
    const configured = env.SLACK_OAUTH_AUTHORIZE_URL;
    if (configured !== "https://slack.com/oauth/v2/authorize") throw new Error();
    const clientId = env.SLACK_CLIENT_ID; const appId = env.SLACK_APP_ID;
    if (!clientId || !/^\d{1,32}\.\d{1,32}$/.test(clientId) || !appId || !/^A[A-Z0-9]{1,63}$/.test(appId)) throw new Error();
    return { appBaseUrl, authorizationUrl: configured, clientId, appId };
  } catch { throw new Error(unavailable); }
}

/** Use only this tenant's existing pilot/connection binding when reconnecting.
 * A first connection is established by the verified Slack code + PKCE grant;
 * browser-supplied workspace IDs never establish tenant authority. */
export async function loadSlackWorkspaceBinding(db: SignalDb, viewer: ViewerTenant): Promise<SlackWorkspaceBinding | null> {
  try {
    requireTenantAdmin(viewer);
    const rows = await db.select({ teamId: tenants.slackTeamId }).from(tenants)
      .where(and(eq(tenants.id, viewer.tenantId), eq(tenants.active, true))).limit(1);
    if (rows.length !== 1) throw new Error();
    const connections = await db.select({ teamId: providerConnections.externalAccountId, botUserId: providerConnections.botUserId })
      .from(providerConnections).where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, "slack"))).limit(2);
    if (connections.length > 1) throw new Error();
    const pilot = rows[0].teamId; const connection = connections[0];
    if ((pilot !== null && !teamId(pilot)) || (connection && (!teamId(connection.teamId) || !botUserId(connection.botUserId)))
      || (pilot && connection && pilot !== connection.teamId)) throw new Error();
    if (connection) return { teamId: connection.teamId, botUserId: connection.botUserId! };
    return pilot ? { teamId: pilot } : null;
  } catch { throw new Error(unavailable); }
}

function redirect(url: URL): NextResponse {
  return new NextResponse(null, { status: 303, headers: { ...protectedHeaders, location: url.href } });
}

/** Server composition seam, never a Server Action. Every operation resolves its
 * own verified session; the repository rechecks persisted admin authority. */
export function createSlackConnectionService(dependencies: SlackConnectionDependencies) {
  async function admin(): Promise<ViewerTenant> {
    const viewer = await dependencies.resolveViewerTenant();
    if (!viewer) throw new ConnectionError(401);
    try { requireTenantAdmin(viewer); } catch { throw new ConnectionError(403); }
    return viewer;
  }
  function returnPath(value: string, baseUrl: string): string {
    if (typeof value !== "string" || validateReturnTo(value, baseUrl) !== value) throw new ConnectionError(400);
    return value;
  }
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { throw error instanceof ConnectionError ? error : new ConnectionError(503); }
  }
  async function beginSlackOAuth(viewer: ViewerTenant | null, returnTo: string): Promise<NextResponse> {
    return guarded(async () => {
      const authority = await admin();
      if (!viewer || viewer.subject !== authority.subject || viewer.tenantId !== authority.tenantId || viewer.role !== authority.role) throw new ConnectionError(403);
      const settings = dependencies.getSettings();
      const destination = returnPath(returnTo, settings.appBaseUrl);
      const binding = await dependencies.loadBinding(authority);
      const state = await dependencies.createOAuthState({ tenantId: authority.tenantId, subject: authority.subject, provider: "slack", returnTo: destination });
      const authorization = await dependencies.getOAuthStateAuthorization(state, { subject: authority.subject, provider: "slack" });
      if (!authorization.codeChallenge || authorization.codeChallengeMethod !== "S256") throw new Error();
      const url = new URL(settings.authorizationUrl);
      url.searchParams.set("client_id", settings.clientId);
      url.searchParams.set("scope", SLACK_CONNECTION_SCOPES.join(","));
      url.searchParams.set("redirect_uri", new URL(callbackPath, settings.appBaseUrl).href);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", authorization.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (binding) url.searchParams.set("team", binding.teamId);
      return redirect(url);
    });
  }
  async function finish(input: CompletionInput): Promise<{ result?: Result; outcome: "connected" | "cancelled" | "error"; returnTo: string; appBaseUrl: string }> {
    return guarded(async () => {
      const viewer = await admin();
      let state: Awaited<ReturnType<typeof consumeOAuthState>>;
      try { state = await dependencies.consumeOAuthState(input.state ?? "", { subject: viewer.subject, provider: "slack" }); }
      catch { throw new ConnectionError(400); }
      if (state.tenantId !== viewer.tenantId || state.completion.tenantId !== viewer.tenantId || state.completion.subject !== viewer.subject
        || state.completion.provider !== "slack" || !state.pkceVerifier) throw new ConnectionError(400);
      const settings = dependencies.getSettings();
      const returnTo = returnPath(state.returnTo, settings.appBaseUrl);
      const destination = { returnTo, appBaseUrl: settings.appBaseUrl };
      if (input.error != null) {
        if (input.code != null) throw new ConnectionError(400);
        return { ...destination, outcome: input.error === "access_denied" ? "cancelled" : "error" };
      }
      if (typeof input.code !== "string" || !/^[A-Za-z0-9._~-]{1,2048}$/.test(input.code)
        || (input.teamId != null && !teamId(input.teamId))) throw new ConnectionError(400);
      const binding = await dependencies.loadBinding(viewer);
      if (binding && input.teamId != null && input.teamId !== binding.teamId) throw new ConnectionError(400);
      let verified: Awaited<ReturnType<typeof exchangeSlackOAuthCode>>;
      try {
        verified = await dependencies.exchangeCode({ clientId: settings.clientId, appId: settings.appId, redirectUri: new URL(callbackPath, settings.appBaseUrl).href }, {
          code: input.code, pkceVerifier: state.pkceVerifier,
          expectedTeamId: binding?.teamId ?? input.teamId ?? undefined, expectedBotUserId: binding?.botUserId,
        });
      } catch { throw new ConnectionError(400); }
      if (!teamId(verified.teamId) || !botUserId(verified.botUserId)
        || (binding && (verified.teamId !== binding.teamId || (binding.botUserId && verified.botUserId !== binding.botUserId)))
        || (input.teamId != null && input.teamId !== verified.teamId)
        || verified.scopes.length !== SLACK_CONNECTION_SCOPES.length || verified.scopes.some((scope, i) => scope !== SLACK_CONNECTION_SCOPES[i])) throw new ConnectionError(400);
      const saved = await dependencies.saveConnection({
        provider: "slack", externalAccountId: verified.teamId, botUserId: verified.botUserId,
        displayName: verified.displayName, scopes: verified.scopes,
        encryptedSecret: sealConnectionSecret(verified.botToken, dependencies.getEncryptionKey()), completion: state.completion,
      });
      if (!saved.connectionId || saved.externalAccountId !== verified.teamId || saved.botUserId !== verified.botUserId) throw new Error();
      return { ...destination, outcome: "connected", result: { connectionId: saved.connectionId, teamId: verified.teamId, botUserId: verified.botUserId, scopes: [...verified.scopes] } };
    });
  }
  return {
    beginSlackOAuth,
    async completeSlackOAuth(input: CompletionInput): Promise<Result> {
      const completed = await finish(input);
      if (!completed.result) throw new ConnectionError(400);
      return completed.result;
    },
    async revokeSlackConnection(): Promise<{ connectionId: string; status: "REVOKED" }> {
      return guarded(async () => {
        await admin();
        // Task 4 atomically clears credentials, disables mappings, burns pending
        // state and advances the generation, retaining audit and replay rows.
        const revoked = await dependencies.revokeConnection();
        if (!revoked.connectionId || revoked.status !== "REVOKED") throw new Error();
        return { connectionId: revoked.connectionId, status: "REVOKED" };
      });
    },
    async handleRoute(request: Request, route: "start" | "callback"): Promise<NextResponse> {
      try {
        const viewer = await admin();
        const query = new URL(request.url).searchParams;
        const allowed = route === "start" ? ["returnTo"] : ["state", "code", "team_id", "error", "error_description"];
        for (const name of query.keys()) if (!allowed.includes(name) || query.getAll(name).length !== 1) throw new ConnectionError(400);
        if (route === "start") return await beginSlackOAuth(viewer, query.get("returnTo") ?? "/settings");
        if (query.has("error_description") && !query.has("error")) throw new ConnectionError(400);
        const completed = await finish({ state: query.get("state"), code: query.get("code"), teamId: query.get("team_id"), error: query.get("error") });
        const destination = new URL(completed.returnTo, completed.appBaseUrl);
        destination.searchParams.set("slack", completed.outcome);
        if (completed.outcome === "connected") destination.searchParams.set("next", "repository-channel-mapping");
        return redirect(destination);
      } catch (error) {
        return new NextResponse(unavailable, { status: error instanceof ConnectionError ? error.status : 503, headers: protectedHeaders });
      }
    },
  };
}

async function withDatabase<T>(work: (db: SignalDb) => Promise<T>): Promise<T> {
  let connection: ReturnType<typeof createDb> | undefined;
  try { connection = createDb(); return await work(connection.db); }
  finally { try { await connection?.pool.end(); } catch { /* Keep driver details private. */ } }
}

export const { beginSlackOAuth, completeSlackOAuth, revokeSlackConnection, handleRoute: handleSlackConnectionRoute } = createSlackConnectionService({
  resolveViewerTenant, getSettings: readSlackConnectionSettings, getEncryptionKey: () => process.env.CONNECTIONS_ENCRYPTION_KEY ?? "",
  createOAuthState, getOAuthStateAuthorization, consumeOAuthState, exchangeCode: exchangeSlackOAuthCode,
  loadBinding: (viewer) => withDatabase((db) => loadSlackWorkspaceBinding(db, viewer)),
  saveConnection: (input) => withDatabase((db) => upsertProviderConnection(db, input)),
  revokeConnection: () => withDatabase((db) => revokeProviderConnection(db, { provider: "slack" })),
});
