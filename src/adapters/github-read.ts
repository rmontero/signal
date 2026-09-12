export type GitHubReadErrorCode =
  | "github_read_invalid"
  | "github_read_rejected"
  | "github_read_unavailable";

export class GitHubReadError extends Error {
  readonly code: GitHubReadErrorCode;
  readonly status?: number;

  constructor(code: GitHubReadErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GitHubReadError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubCandidate {
  id: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: "open" | "closed";
  isPullRequest: boolean;
  authorLogin: string | null;
}

export interface GitHubReconciliationRecord {
  id: string;
  url: string;
  body: string;
  authorLogin: string | null;
  issueNumber?: number;
  issueId?: string;
  title?: string;
}

export interface GitHubReadClient {
  search(input: {
    owner: string;
    repo: string;
    queries: string[];
    signal?: AbortSignal;
  }): Promise<GitHubCandidate[]>;
  getIssue(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    signal?: AbortSignal;
  }): Promise<GitHubCandidate>;
  listIssues?: (input: { owner: string; repo: string; signal?: AbortSignal }) => Promise<GitHubReconciliationRecord[]>;
  listComments?: (input: { owner: string; repo: string; issueNumber: number; signal?: AbortSignal }) => Promise<GitHubReconciliationRecord[]>;
}

export interface GitHubReadClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  maxReadRetries?: number;
}

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DEFAULT_RETRIES = 2;
const MAX_CANDIDATES = 5;
const MAX_RECONCILIATION_PAGES = 10;

function assertRepositoryPart(value: string, label: string): void {
  if (!OWNER_OR_REPO.test(value) || value.length > 100) {
    throw new GitHubReadError("github_read_invalid", `Invalid GitHub ${label}`);
  }
}

function assertRepository(owner: string, repo: string): void {
  assertRepositoryPart(owner, "owner");
  assertRepositoryPart(repo, "repository");
}

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new GitHubReadError("github_read_invalid", "Invalid GitHub issue number");
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function parseHttpUrl(value: unknown, owner: string, repo: string): string {
  if (typeof value !== "string") {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid URL");
  }
  const path = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || path.length !== 4 || path[0] !== owner || path[1] !== repo || !["issues", "pull"].includes(path[2]!)) {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an out-of-scope URL");
  }
  return url.toString();
}

function parseCandidate(value: unknown, owner: string, repo: string): GitHubCandidate {
  if (typeof value !== "object" || value === null) {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid candidate");
  }
  const item = value as Record<string, unknown>;
  const id = item.id;
  const number = item.number;
  const title = item.title;
  const state = item.state;
  if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id)) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid candidate ID");
  }
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || typeof title !== "string" || !title.trim() || (state !== "open" && state !== "closed")) {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid candidate");
  }
  const htmlUrl = parseHttpUrl(item.html_url, owner, repo);
  const author = item.user;
  const authorLogin = typeof author === "object" && author !== null && LOGIN.test(String((author as Record<string, unknown>).login ?? ""))
    ? String((author as Record<string, unknown>).login)
    : null;
  const isPullRequest = typeof item.pull_request === "object" || new URL(htmlUrl).pathname.includes("/pull/");
  return { id: String(id), number, title: title.trim(), htmlUrl, state, isPullRequest, authorLogin };
}

function parseNumericId(value: unknown): string {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value)) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid reconciliation ID");
  }
  return String(value);
}

function parseReconciliationIssue(value: unknown, owner: string, repo: string): GitHubReconciliationRecord {
  const candidate = parseCandidate(value, owner, repo);
  const item = value as Record<string, unknown>;
  return {
    id: candidate.id,
    url: candidate.htmlUrl,
    body: typeof item.body === "string" ? item.body : "",
    authorLogin: candidate.authorLogin,
    issueNumber: candidate.number,
    title: candidate.title,
  };
}

function parseReconciliationComment(value: unknown, owner: string, repo: string, issueNumber: number): GitHubReconciliationRecord {
  if (typeof value !== "object" || value === null) throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid comment");
  const item = value as Record<string, unknown>;
  if (typeof item.body !== "string" || !item.body) throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid comment body");
  const htmlUrl = parseHttpUrl(item.html_url, owner, repo);
  const user = item.user;
  const authorLogin = typeof user === "object" && user !== null && LOGIN.test(String((user as Record<string, unknown>).login ?? ""))
    ? String((user as Record<string, unknown>).login)
    : null;
  return { id: parseNumericId(item.id), url: htmlUrl, body: item.body, authorLogin, issueNumber };
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export function createGitHubReadClient(options: GitHubReadClientOptions): GitHubReadClient {
  if (!options.token) throw new GitHubReadError("github_read_invalid", "GitHub token is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new GitHubReadError("github_read_invalid", "Fetch is unavailable in this runtime");
  const baseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const wait = options.wait ?? (async (milliseconds: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
  const maxRetries = options.maxReadRetries ?? DEFAULT_RETRIES;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) {
    throw new GitHubReadError("github_read_invalid", "Invalid GitHub read retry limit");
  }

  async function readJson(path: string, signal?: AbortSignal, query?: Record<string, string>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(buildUrl(baseUrl, path, query), {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "x-github-api-version": "2022-11-28",
          },
          redirect: "error",
          signal,
        });
    } catch {
        if (attempt < maxRetries) {
          await wait(250);
          continue;
        }
        throw new GitHubReadError("github_read_unavailable", "GitHub read request was unavailable");
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        await wait(retryAfterMilliseconds(response.headers.get("retry-after")) ?? 250);
        continue;
      }
      if (retryable) throw new GitHubReadError("github_read_unavailable", "GitHub read provider unavailable", response.status);
      if (!response.ok) throw new GitHubReadError("github_read_rejected", "GitHub rejected a read request", response.status);
      try {
        return await response.json();
      } catch {
        throw new GitHubReadError("github_read_invalid", "GitHub returned invalid JSON", response.status);
      }
    }
  }

  return {
    async search(input) {
      assertRepository(input.owner, input.repo);
      if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > 2 || input.queries.some((query) => typeof query !== "string" || !query.trim() || query.length > 200)) {
        throw new GitHubReadError("github_read_invalid", "GitHub search requires one or two bounded queries");
      }
      const results: GitHubCandidate[] = [];
      const seen = new Set<string>();
      for (const query of input.queries) {
        const payload = await readJson("search/issues", input.signal, {
          q: `${query.trim()} repo:${input.owner}/${input.repo}`,
          per_page: String(MAX_CANDIDATES),
          page: "1",
        });
        if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Record<string, unknown>).items)) {
          throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid search response");
        }
        for (const item of (payload as { items: unknown[] }).items) {
          const candidate = parseCandidate(item, input.owner, input.repo);
          if (!seen.has(candidate.id)) {
            seen.add(candidate.id);
            results.push(candidate);
          }
          if (results.length === MAX_CANDIDATES) return results;
        }
      }
      return results;
    },

    async getIssue(input) {
      assertRepository(input.owner, input.repo);
      assertIssueNumber(input.issueNumber);
      const payload = await readJson(`repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`, input.signal);
      return parseCandidate(payload, input.owner, input.repo);
    },

    async listIssues(input) {
      assertRepository(input.owner, input.repo);
      const records: GitHubReconciliationRecord[] = [];
      for (let page = 1; page <= MAX_RECONCILIATION_PAGES; page += 1) {
        const payload = await readJson(`repos/${input.owner}/${input.repo}/issues`, input.signal, { state: "all", per_page: "100", page: String(page) });
        if (!Array.isArray(payload)) throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid issue list");
        records.push(...payload.map((item) => parseReconciliationIssue(item, input.owner, input.repo)));
        if (payload.length < 100) return records;
      }
      throw new GitHubReadError("github_read_unavailable", "GitHub issue reconciliation exceeded the page bound");
    },

    async listComments(input) {
      assertRepository(input.owner, input.repo);
      assertIssueNumber(input.issueNumber);
      const records: GitHubReconciliationRecord[] = [];
      for (let page = 1; page <= MAX_RECONCILIATION_PAGES; page += 1) {
        const payload = await readJson(`repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`, input.signal, { per_page: "100", page: String(page) });
        if (!Array.isArray(payload)) throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid comment list");
        records.push(...payload.map((item) => parseReconciliationComment(item, input.owner, input.repo, input.issueNumber)));
        if (payload.length < 100) return records;
      }
      throw new GitHubReadError("github_read_unavailable", "GitHub comment reconciliation exceeded the page bound");
    },
  };
}
