import "server-only";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server.js";
import { verifyGitHubInstallation, type GitHubAppCredentials, type GitHubInstallationScope, type VerifiedGitHubInstallation } from "../adapters/github-app";
import { createDb, type SignalDb } from "../db/client";
import { upsertProviderConnection } from "../db/connection-repository";
import { requireTenantAdmin } from "../db/membership-repository";
import { channelMappings, providerConnections } from "../db/schema";
import { readAuth0Settings, validateReturnTo } from "../lib/auth0";
import { consumeOAuthState, createOAuthState } from "../lib/oauth-state";
import { resolveViewerTenant, type ViewerTenant } from "../lib/tenant-context";

type Settings = { appBaseUrl: string; installationUrl: string; appSlug: string; credentials: GitHubAppCredentials };
type GitHubConnectionInput = Extract<Parameters<typeof upsertProviderConnection>[1], { provider: "github" }>;
type CompletionInput = { state: string | null; installationId: string | null; setupAction?: string | null };
type Result = { connectionId: string; installationId: string };
export interface GitHubConnectionDependencies {
  resolveViewerTenant(): Promise<ViewerTenant | null>;
  getSettings(): Settings;
  loadScope(viewer: ViewerTenant): Promise<GitHubInstallationScope | null>;
  createOAuthState: typeof createOAuthState;
  consumeOAuthState: typeof consumeOAuthState;
  verifyInstallation(settings: Settings, scope: GitHubInstallationScope): Promise<VerifiedGitHubInstallation>;
  saveConnection(input: GitHubConnectionInput): Promise<{ connectionId: string; installationId: string | null }>;
}

const unavailable = "GitHub connection is unavailable.";
const isId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
class ConnectionError extends Error {
  constructor(readonly status: number) { super(unavailable); }
}

export function readGitHubConnectionSettings(env: Record<string, string | undefined> = process.env): Settings {
  try {
    const { appBaseUrl } = readAuth0Settings(env);
    const configured = env.GITHUB_APP_INSTALLATION_URL;
    if (!configured || configured !== configured.trim()) throw new Error();
    const url = new URL(configured);
    const match = /^\/apps\/([a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?)\/installations\/new$/.exec(url.pathname);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !match) throw new Error();
    const appId = env.GITHUB_APP_ID;
    const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n");
    if (!isId(appId) || !privateKey?.includes("BEGIN")) throw new Error();
    return { appBaseUrl, installationUrl: url.href, appSlug: match[1], credentials: { appId, privateKey } };
  } catch { throw new Error(unavailable); }
}

type Binding = { installationId: string | null; externalAccountId: string; displayName: string };
type Mapping = { installationId: string; repositoryId: string; repositoryOwner: string; repositoryName: string };
/** Existing tenant records establish intended authority. A setup callback ID
 * and a successful App lookup alone cannot prove that installation's tenant. */
export function resolveGitHubInstallationScope(connections: Binding[], mappings: Mapping[]): GitHubInstallationScope | null {
  if (connections.length > 1 || mappings.length > 100) throw new Error(unavailable);
  const binding = connections[0];
  const first = mappings[0];
  if (!binding && !first) return null;
  if (binding && !isId(binding.installationId)) throw new Error(unavailable);
  const installationId = binding?.installationId ?? first?.installationId;
  const accountId = binding?.externalAccountId;
  const accountLogin = binding?.displayName ?? first?.repositoryOwner;
  if (!isId(installationId) || (binding && !isId(accountId)) || !accountLogin || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(accountLogin)) throw new Error(unavailable);
  const repositories = new Map<string, GitHubInstallationScope["repositories"][number]>();
  const coordinates = new Map<string, string>();
  for (const mapping of mappings) {
    if (mapping.installationId !== installationId || mapping.repositoryOwner !== accountLogin || !isId(mapping.repositoryId)
      || !/^[A-Za-z0-9_.-]{1,100}$/.test(mapping.repositoryName) || [".", ".."].includes(mapping.repositoryName)) throw new Error(unavailable);
    const previous = repositories.get(mapping.repositoryId);
    const coordinate = coordinates.get(mapping.repositoryName);
    if ((previous && previous.repo !== mapping.repositoryName) || (coordinate && coordinate !== mapping.repositoryId)) throw new Error(unavailable);
    repositories.set(mapping.repositoryId, { id: mapping.repositoryId, owner: mapping.repositoryOwner, repo: mapping.repositoryName });
    coordinates.set(mapping.repositoryName, mapping.repositoryId);
  }
  return { installationId, accountId, accountLogin, repositories: [...repositories.values()] };
}

async function withDatabase<T>(work: (db: SignalDb) => Promise<T>): Promise<T> {
  let connection: ReturnType<typeof createDb> | undefined;
  try { connection = createDb(); return await work(connection.db); }
  finally { try { await connection?.pool.end(); } catch { /* Never expose connection errors. */ } }
}

export async function loadGitHubInstallationScope(db: SignalDb, viewer: ViewerTenant): Promise<GitHubInstallationScope | null> {
  requireTenantAdmin(viewer);
  const connections = await db.select({ installationId: providerConnections.installationId, externalAccountId: providerConnections.externalAccountId, displayName: providerConnections.displayName })
    .from(providerConnections).where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, "github"))).limit(2);
  const mappings = await db.select({ installationId: channelMappings.installationId, repositoryId: channelMappings.repositoryId, repositoryOwner: channelMappings.repositoryOwner, repositoryName: channelMappings.repositoryName })
    .from(channelMappings).where(and(eq(channelMappings.tenantId, viewer.tenantId), eq(channelMappings.enabled, true))).limit(101);
  return resolveGitHubInstallationScope(connections, mappings);
}

const protectedHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };
function redirect(url: URL, message?: string): NextResponse {
  return new NextResponse(message ?? null, { status: 303, headers: { ...protectedHeaders, location: url.href, "content-type": "text/plain; charset=utf-8" } });
}

/** Server-only composition seam; callers cannot select the authenticated tenant. */
export function createGitHubConnectionService(dependencies: GitHubConnectionDependencies) {
  async function admin(): Promise<ViewerTenant> {
    const viewer = await dependencies.resolveViewerTenant();
    if (!viewer) throw new ConnectionError(401);
    try { requireTenantAdmin(viewer); } catch { throw new ConnectionError(403); }
    return viewer;
  }
  function returnPath(value: string, baseUrl: string) {
    if (validateReturnTo(value, baseUrl) !== value) throw new ConnectionError(400);
    return value;
  }
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { throw error instanceof ConnectionError ? error : new ConnectionError(503); }
  }
  async function beginGitHubInstallation(viewer: ViewerTenant | null, returnTo: string): Promise<NextResponse> {
    return guarded(async () => {
      const authority = await admin();
      if (!viewer || viewer.subject !== authority.subject || viewer.tenantId !== authority.tenantId || viewer.role !== authority.role) throw new ConnectionError(403);
      const config = dependencies.getSettings();
      const destination = returnPath(returnTo, config.appBaseUrl);
      if (!await dependencies.loadScope(authority)) throw new ConnectionError(503);
      const state = await dependencies.createOAuthState({ tenantId: authority.tenantId, subject: authority.subject, provider: "github", returnTo: destination });
      const url = new URL(config.installationUrl);
      url.searchParams.set("state", state);
      return redirect(url);
    });
  }
  async function finish(input: CompletionInput): Promise<{ result: Result; returnTo: string; appBaseUrl: string }> {
    return guarded(async () => {
      const viewer = await admin();
      let state: Awaited<ReturnType<typeof consumeOAuthState>>;
      try {
        state = await dependencies.consumeOAuthState(input.state ?? "", { subject: viewer.subject, provider: "github" });
      } catch { throw new ConnectionError(400); }
      if (state.tenantId !== viewer.tenantId || state.completion.tenantId !== viewer.tenantId || state.completion.subject !== viewer.subject
        || state.completion.provider !== "github" || !isId(input.installationId)
        || (input.setupAction != null && !["install", "update"].includes(input.setupAction))) throw new ConnectionError(400);
      const config = dependencies.getSettings();
      const returnTo = returnPath(state.returnTo, config.appBaseUrl);
      const expected = await dependencies.loadScope(viewer);
      if (!expected) throw new ConnectionError(503);
      if (expected.installationId !== input.installationId) throw new ConnectionError(400);
      let verified: VerifiedGitHubInstallation;
      try { verified = await dependencies.verifyInstallation(config, expected); }
      catch { throw new ConnectionError(400); }
      if (verified.installationId !== expected.installationId || verified.accountLogin !== expected.accountLogin
        || !isId(verified.accountId) || (expected.accountId !== undefined && verified.accountId !== expected.accountId)) throw new ConnectionError(400);
      const saved = await dependencies.saveConnection({
        provider: "github", installationId: verified.installationId, externalAccountId: verified.accountId,
        displayName: verified.accountLogin, scopes: verified.scopes, completion: state.completion,
      });
      if (saved.installationId !== expected.installationId || !saved.connectionId) throw new Error();
      return { result: { connectionId: saved.connectionId, installationId: saved.installationId }, returnTo, appBaseUrl: config.appBaseUrl };
    });
  }
  return {
    beginGitHubInstallation,
    async completeGitHubInstallation(input: CompletionInput): Promise<Result> { return (await finish(input)).result; },
    async handleRoute(request: Request, route: "start" | "callback"): Promise<NextResponse> {
      try {
        const viewer = await admin();
        const query = new URL(request.url).searchParams;
        const allowed = route === "start" ? ["returnTo"] : ["state", "installation_id", "setup_action"];
        for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ConnectionError(400);
        if (route === "start") return await beginGitHubInstallation(viewer, query.get("returnTo") ?? "/settings");
        const completed = await finish({ state: query.get("state"), installationId: query.get("installation_id"), setupAction: query.get("setup_action") });
        const destination = new URL(completed.returnTo, completed.appBaseUrl);
        destination.searchParams.set("github", "connected");
        destination.searchParams.set("next", "repository-channel-mapping");
        return redirect(destination, "GitHub connected. Repository and Slack channel mapping is a separate next step.");
      } catch (error) {
        return new NextResponse(unavailable, { status: error instanceof ConnectionError ? error.status : 503, headers: protectedHeaders });
      }
    },
  };
}

export const { beginGitHubInstallation, completeGitHubInstallation, handleRoute: handleGitHubConnectionRoute } = createGitHubConnectionService({
  resolveViewerTenant, getSettings: readGitHubConnectionSettings, createOAuthState, consumeOAuthState,
  loadScope: (viewer) => withDatabase((db) => loadGitHubInstallationScope(db, viewer)),
  verifyInstallation: (settings, expected) => verifyGitHubInstallation(settings.credentials, expected, { appSlug: settings.appSlug }),
  saveConnection: (input) => withDatabase((db) => upsertProviderConnection(db, input)),
});
