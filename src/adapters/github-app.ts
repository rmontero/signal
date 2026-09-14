import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { createGitHubReadClient, type GitHubReadClient, type GitHubReadClientOptions } from "./github-read";
import { createGitHubWriteClient, type GitHubWriteClient, type GitHubWriteClientOptions } from "./github-write-standalone.mts";

export type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
};

function validateCredentials(credentials: GitHubAppCredentials): void {
  if (!/^\d+$/.test(credentials.appId) || !credentials.privateKey.includes("BEGIN")) {
    throw new Error("github_app_configuration_invalid");
  }
}

export async function mintGitHubInstallationToken(
  credentials: GitHubAppCredentials,
  installationId: string,
): Promise<string> {
  validateCredentials(credentials);
  if (!/^\d+$/.test(installationId)) throw new Error("github_installation_invalid");
  const auth = createAppAuth({ appId: credentials.appId, privateKey: credentials.privateKey });
  const result = await auth({ type: "installation", installationId });
  if (!result.token) throw new Error("github_installation_token_missing");
  return result.token;
}

export async function createGitHubAppClients(
  credentials: GitHubAppCredentials,
  installationId: string,
  options: { apiBaseUrl?: string; fetchImpl?: typeof fetch; wait?: (milliseconds: number) => Promise<void>; maxReadRetries?: number } = {},
): Promise<{ read: GitHubReadClient; write: GitHubWriteClient }> {
  const token = await mintGitHubInstallationToken(credentials, installationId);
  const readOptions: GitHubReadClientOptions = { token, ...options };
  const writeOptions: GitHubWriteClientOptions = { token, apiBaseUrl: options.apiBaseUrl, fetchImpl: options.fetchImpl };
  return { read: createGitHubReadClient(readOptions), write: createGitHubWriteClient(writeOptions) };
}

/** Trusted, tenant-scoped persisted identities, never callback query authority. */
export type GitHubInstallationScope = {
  installationId: string;
  accountId?: string;
  accountLogin: string;
  repositories: { id: string; owner: string; repo: string }[];
};

export type VerifiedGitHubInstallation = {
  installationId: string;
  accountId: string;
  accountLogin: string;
  scopes: string[];
};

const verificationUnavailable = "GitHub installation verification is unavailable.";
const apiOrigin = "https://api.github.com";
const numericId = (value: unknown): string => {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error();
  return String(value);
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
};
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/;

/** Read-only verification using App JWT + installation-token authority. The
 * only POST mints a short-lived App installation token; no personal OAuth or
 * repository mutation is available here. All provider material stays inside. */
export async function verifyGitHubInstallation(
  credentials: GitHubAppCredentials,
  expected: GitHubInstallationScope,
  options: { appSlug: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<VerifiedGitHubInstallation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    validateCredentials(credentials);
    numericId(credentials.appId);
    if (typeof expected.installationId !== "string" || numericId(expected.installationId) !== expected.installationId
      || typeof expected.accountLogin !== "string" || !loginPattern.test(expected.accountLogin)
      || (expected.accountId !== undefined && (typeof expected.accountId !== "string" || numericId(expected.accountId) !== expected.accountId))
      || !Array.isArray(expected.repositories) || expected.repositories.length > 100
      || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(options.appSlug)) throw new Error();
    for (const repository of expected.repositories) {
      if (numericId(repository.id) !== repository.id || repository.owner !== expected.accountLogin
        || !repositoryPattern.test(repository.repo) || [".", ".."].includes(repository.repo)) throw new Error();
    }
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error();
    const aborted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(verificationUnavailable)); }, timeout);
    });
    const bounded = <T>(work: () => Promise<T>) => {
      if (controller.signal.aborted) throw new Error();
      return Promise.race([Promise.resolve().then(work), aborted]);
    };
    const upstream = options.fetchImpl ?? globalThis.fetch;
    // Bound the body too, including Octokit's token exchange. Never follow a
    // provider redirect with App credentials or let SDK diagnostics log it.
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await bounded(() => upstream(input, { ...init, redirect: "error", cache: "no-store", signal: controller.signal }));
      const declared = response.headers.get("content-length");
      if (![200, 201].includes(response.status) || response.redirected || (response.url && response.url !== String(input))
        || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2_000_000))) {
        void response.body?.cancel().catch(() => {});
        throw new Error();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await bounded(() => reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) throw new Error();
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      const headers = new Headers({ "content-type": "application/json" });
      const link = response.headers.get("link");
      if (link) headers.set("link", link);
      return new Response(body, { status: response.status, headers });
    };
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const request = new Octokit({ request: { fetch: fetchImpl }, log: quiet }).request;
    const auth = createAppAuth({ ...credentials, request, log: quiet });
    const readJson = async (path: string, token: string) => {
      const response = await fetchImpl(`${apiOrigin}${path}`, { method: "GET", headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
      } });
      if (response.status !== 200) throw new Error();
      return { data: object(await response.json()), link: response.headers.get("link") };
    };
    return await bounded(async () => {
      const app = await auth({ type: "app" });
      const { data } = await readJson(`/app/installations/${expected.installationId}`, app.token);
      const account = object(data.account);
      const accountId = numericId(account.id);
      if (numericId(data.id) !== expected.installationId || numericId(data.app_id) !== credentials.appId || data.app_slug !== options.appSlug
        || (expected.accountId !== undefined && accountId !== expected.accountId) || account.login !== expected.accountLogin
        || !["User", "Organization"].includes(String(account.type)) || data.target_type !== account.type || numericId(data.target_id) !== accountId
        || data.suspended_at !== null || data.suspended_by !== null || !["all", "selected"].includes(String(data.repository_selection))) throw new Error();
      const permissions = object(data.permissions);
      if (permissions.metadata !== "read" || permissions.issues !== "write" || !["read", "write"].includes(String(permissions.pull_requests))) throw new Error();
      // Persist only the permissions Signal actually verifies and uses.
      const scopes = ["issues:write", "metadata:read", `pull_requests:${permissions.pull_requests}`];
      const token = await auth({ type: "installation", installationId: expected.installationId });
      if (!token.token || String(token.installationId) !== expected.installationId || token.repositorySelection !== data.repository_selection
        || token.permissions?.metadata !== "read" || token.permissions?.issues !== "write"
        || token.permissions?.pull_requests !== permissions.pull_requests) throw new Error();
      const repositories = new Map<string, { id: string; owner: string; repo: string }>();
      const coordinates = new Set<string>();
      let total: number | undefined;
      for (let page = 1; page <= 10; page++) {
        const response = await readJson(`/installation/repositories?per_page=100&page=${page}`, token.token);
        const count = response.data.total_count;
        const items = response.data.repositories;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 1000
          || (total !== undefined && total !== count) || !Array.isArray(items) || items.length !== Math.min(100, count - (page - 1) * 100)) throw new Error();
        total = count;
        const pages = Math.ceil(count / 100);
        if (response.link) {
          const seen = new Set<string>();
          for (const part of response.link.split(",")) {
            const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
            if (!match || seen.has(match[2])) throw new Error();
            seen.add(match[2]);
            const next = { next: page + 1, prev: page - 1, first: 1, last: pages }[match[2]]!;
            const target = new URL(match[1]);
            if ([...target.searchParams.keys()].length !== 2) throw new Error();
            target.searchParams.sort();
            if (next < 1 || next > pages || target.href !== `${apiOrigin}/installation/repositories?page=${next}&per_page=100`) throw new Error();
          }
          if (page < pages && !seen.has("next")) throw new Error();
        }
        for (const item of items) {
          const repo = object(item);
          const id = numericId(repo.id);
          const owner = object(repo.owner);
          if (numericId(owner.id) !== accountId || owner.login !== expected.accountLogin || typeof repo.name !== "string"
            || !repositoryPattern.test(repo.name) || [".", ".."].includes(repo.name) || repo.full_name !== `${expected.accountLogin}/${repo.name}`
            || repo.html_url !== `https://github.com/${expected.accountLogin}/${repo.name}` || repositories.has(id) || coordinates.has(repo.full_name)) throw new Error();
          coordinates.add(repo.full_name);
          repositories.set(id, { id, owner: expected.accountLogin, repo: repo.name });
        }
        if (page === pages) break;
      }
      if (repositories.size !== total) throw new Error();
      const read = createGitHubReadClient({ token: token.token, fetchImpl, maxReadRetries: 0 });
      for (const required of expected.repositories) {
        const listed = repositories.get(required.id);
        if (!listed || listed.owner !== required.owner || listed.repo !== required.repo) throw new Error();
        const actual = await read.getRepository!({ owner: required.owner, repo: required.repo, signal: controller.signal });
        if (actual.id !== required.id || actual.owner !== required.owner || actual.repo !== required.repo) throw new Error();
      }
      return { installationId: expected.installationId, accountId, accountLogin: expected.accountLogin, scopes };
    });
  } catch {
    throw new Error(verificationUnavailable);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
