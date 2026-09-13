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
  assignees?: string[];
}

export type GitHubPullRequestEvidence = {
  id: string;
  sourceId: string;
  permalink: string;
  body: string;
  authorLogin: string | null;
  createdAt: string | null;
  updatedAt: string | null;
} & (
  | { kind: "pull_request_body" }
  | { kind: "review"; reviewState: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" }
  | { kind: "review_comment"; reviewId: string | null }
  | { kind: "issue_comment" }
);

export interface GitHubPullRequestConversation {
  repository: { id: string; owner: string; repo: string };
  /** The ID is the REST /pulls ID, which is distinct from its /issues ID. */
  pullRequest: GitHubCandidate;
  evidence: GitHubPullRequestEvidence[];
  /** No partial result is returned on overflow or incomplete pagination. */
  complete: true;
}

export interface GitHubReadClient {
  getRepository?: (input: { owner: string; repo: string; signal?: AbortSignal }) => Promise<{ id: string; owner: string; repo: string }>;
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
  getPullRequestConversation?: (input: {
    owner: string;
    repo: string;
    repositoryId: string;
    pullRequestNumber: number;
    pullRequestId?: string;
    signal?: AbortSignal;
  }) => Promise<GitHubPullRequestConversation>;
}

export interface GitHubReadClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxReadRetries?: number;
  /** Total budget for one public call, including all pages, bodies and retries. */
  readTimeoutMs?: number;
  /** Longer provider delays fail closed, rather than retrying before permitted. */
  maxRetryAfterMs?: number;
}

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const DEFAULT_RETRIES = 2;
const MAX_CANDIDATES = 5;
const MAX_RECONCILIATION_PAGES = 10;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 5_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CONVERSATION_RECORDS = 50;
const MAX_CONVERSATION_CHARACTERS = 40_000;

function invalid(message: string): GitHubReadError {
  return new GitHubReadError("github_read_invalid", message);
}

function unavailable(message: string, status?: number): GitHubReadError {
  return new GitHubReadError("github_read_unavailable", message, status);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("GitHub returned an invalid object");
  return value as Record<string, unknown>;
}

function assertRepositoryPart(value: string, label: string): void {
  if (typeof value !== "string" || !OWNER_OR_REPO.test(value) || value.length > 100 || value === "." || value === "..") {
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

function retryAfterMilliseconds(value: string): number {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  // Accept HTTP dates, but not Date.parse's permissive numeric/date guesses.
  if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  throw unavailable("GitHub returned an invalid retry delay");
}

function assertUrl(value: unknown, expected: string): void {
  if (value !== expected) throw invalid("GitHub returned a mismatched target URL");
}

function authorLogin(item: Record<string, unknown>): string | null {
  if (item.user === null || item.user === undefined) return null;
  const login = record(item.user).login;
  if (typeof login !== "string" || !LOGIN.test(login)) throw invalid("GitHub returned an invalid author");
  return login;
}

function parseCandidate(value: unknown, owner: string, repo: string, baseUrl: string): GitHubCandidate {
  const item = record(value);
  const id = parseNumericId(item.id);
  const number = item.number;
  const title = item.title;
  const state = item.state;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || typeof title !== "string" || !title.trim() || title.length > 256 || (state !== "open" && state !== "closed")) {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid candidate");
  }
  const isPullRequest = item.html_url === `https://github.com/${owner}/${repo}/pull/${number}`;
  const htmlUrl = `https://github.com/${owner}/${repo}/${isPullRequest ? "pull" : "issues"}/${number}`;
  assertUrl(item.html_url, htmlUrl);
  if (item.pull_request !== undefined) {
    const pr = record(item.pull_request);
    if (!isPullRequest) throw invalid("GitHub returned a mismatched pull request");
    if (pr.url !== undefined) assertUrl(pr.url, buildUrl(baseUrl, `repos/${owner}/${repo}/pulls/${number}`));
  }
  if (item.repository_url !== undefined) assertUrl(item.repository_url, buildUrl(baseUrl, `repos/${owner}/${repo}`));
  if (item.url !== undefined && item.url !== buildUrl(baseUrl, `repos/${owner}/${repo}/issues/${number}`) && (!isPullRequest || item.url !== buildUrl(baseUrl, `repos/${owner}/${repo}/pulls/${number}`))) throw invalid("GitHub returned a mismatched candidate API identity");
  return { id, number, title, htmlUrl: item.html_url as string, state, isPullRequest, authorLogin: authorLogin(item) };
}

function parseNumericId(value: unknown): string {
  if ((typeof value !== "number" && typeof value !== "string") || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new GitHubReadError("github_read_invalid", "GitHub returned an invalid reconciliation ID");
  }
  return String(value);
}

function body(item: Record<string, unknown>, nullable = false): string {
  if (nullable && item.body === null) return "";
  if (typeof item.body !== "string") throw invalid("GitHub returned an invalid body");
  return item.body;
}

function parseReconciliationIssue(value: unknown, owner: string, repo: string, baseUrl: string): GitHubReconciliationRecord | null {
  const candidate = parseCandidate(value, owner, repo, baseUrl);
  if (candidate.isPullRequest) return null;
  const item = record(value);
  return {
    id: candidate.id,
    url: candidate.htmlUrl,
    body: body(item, true),
    authorLogin: candidate.authorLogin,
    issueNumber: candidate.number,
    title: candidate.title,
    ...(item.assignees === undefined ? {} : { assignees: parseAssignees(item.assignees) }),
  };
}

function parseAssignees(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid("GitHub returned invalid assignees");
  const logins = value.map((assignee) => {
    const login = record(assignee).login;
    if (typeof login !== "string" || !LOGIN.test(login)) throw invalid("GitHub returned an invalid assignee");
    return login;
  });
  if (new Set(logins).size !== logins.length) throw invalid("GitHub returned duplicate assignees");
  return logins;
}

function parseReconciliationComment(value: unknown, owner: string, repo: string, issueNumber: number, issueId: string, baseUrl: string): GitHubReconciliationRecord {
  const item = record(value);
  const id = parseNumericId(item.id);
  assertUrl(item.html_url, `https://github.com/${owner}/${repo}/issues/${issueNumber}#issuecomment-${id}`);
  if (item.issue_url !== undefined) assertUrl(item.issue_url, buildUrl(baseUrl, `repos/${owner}/${repo}/issues/${issueNumber}`));
  return { id, url: item.html_url as string, body: body(item), authorLogin: authorLogin(item), issueNumber, issueId };
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

interface ReadScope {
  signal: AbortSignal;
  check(): void;
  remaining(): number;
  run<T>(action: () => Promise<T>): Promise<T>;
}

async function boundedRead<T>(timeoutMs: number, externalSignal: AbortSignal | undefined, action: (scope: ReadScope) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const cancel = () => controller.abort(unavailable("GitHub read was cancelled"));
  const expire = () => controller.abort(unavailable("GitHub read deadline exceeded"));
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(expire, timeoutMs);
  const scope: ReadScope = {
    signal: controller.signal,
    remaining: () => Math.max(0, expiresAt - performance.now()),
    check() {
      if (performance.now() >= expiresAt) expire();
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    async run(work) {
      scope.check();
      let rejectOnAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      try {
        // Check again before invoking injected transports that ignore AbortSignal.
        const result = await Promise.race([Promise.resolve().then(() => { scope.check(); return work(); }), aborted]);
        scope.check();
        return result;
      } finally {
        controller.signal.removeEventListener("abort", rejectOnAbort);
      }
    },
  };
  try {
    return await scope.run(() => action(scope));
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", cancel);
  }
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(unavailable("GitHub read was cancelled")); return; }
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(unavailable("GitHub read was cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function readBody(response: Response, scope: ReadScope): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw unavailable("GitHub response exceeded the byte bound");
  }
  if (!response.body) throw invalid("GitHub returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  let complete = false;
  try {
    while (!complete) {
      const chunk = await scope.run(() => reader.read());
      complete = chunk.done;
      if (chunk.value) {
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw unavailable("GitHub response exceeded the byte bound");
        text += decoder.decode(chunk.value, { stream: true });
      }
    }
    text += decoder.decode();
    const payload: unknown = JSON.parse(text);
    scope.check();
    return payload;
  } catch (error) {
    scope.check();
    if (error instanceof GitHubReadError) throw error;
    throw invalid("GitHub returned invalid JSON");
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function hasNextPage(link: string | null, requestUrl: string, page: number, length: number, perPage: number): boolean {
  if (link === null) return length === perPage; // Probe a full page even if Link is missing.
  const expected = new URL(requestUrl);
  const relations = new Map<string, number>();
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    if (!match || relations.has(match[2]!)) throw invalid("GitHub returned invalid pagination");
    let url: URL;
    try { url = new URL(match[1]!); } catch { throw invalid("GitHub returned invalid pagination"); }
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) throw invalid("GitHub returned ambiguous pagination");
    const targetPage = url.searchParams.get("page");
    if (!targetPage || !/^[1-9]\d*$/.test(targetPage) || !Number.isSafeInteger(Number(targetPage))) throw invalid("GitHub returned invalid pagination");
    url.searchParams.set("page", String(page));
    url.searchParams.sort();
    expected.searchParams.sort();
    if (url.toString() !== expected.toString()) throw invalid("GitHub returned out-of-scope pagination");
    relations.set(match[2]!, Number(targetPage));
  }
  const next = relations.get("next");
  const last = relations.get("last");
  const previous = relations.get("prev");
  if ((relations.has("first") && relations.get("first") !== 1) || (previous !== undefined && previous !== page - 1)) throw unavailable("GitHub returned inconsistent pagination");
  if (next !== undefined && (next !== page + 1 || length === 0)) throw unavailable("GitHub pagination did not advance");
  if (last !== undefined && (last < page || (next !== undefined && last < next))) throw unavailable("GitHub returned inconsistent pagination");
  if (last !== undefined && last > page && next === undefined) throw unavailable("GitHub pagination was incomplete");
  return next !== undefined || (length === perPage && last !== page);
}

function timestamp(value: unknown, required = true): string | null {
  if (!required && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalid("GitHub returned an invalid timestamp");
  return value;
}

export function createGitHubReadClient(options: GitHubReadClientOptions): GitHubReadClient {
  if (!options.token) throw new GitHubReadError("github_read_invalid", "GitHub token is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new GitHubReadError("github_read_invalid", "Fetch is unavailable in this runtime");
  let baseUrl: string;
  try {
    const url = new URL(options.apiBaseUrl ?? "https://api.github.com");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    baseUrl = url.toString().replace(/\/$/, "");
  } catch { throw invalid("Invalid GitHub API base URL"); }
  const wait = options.wait ?? waitForRetry;
  const maxRetries = options.maxReadRetries ?? DEFAULT_RETRIES;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) {
    throw new GitHubReadError("github_read_invalid", "Invalid GitHub read retry limit");
  }
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > 60_000 || !Number.isSafeInteger(maxRetryAfterMs) || maxRetryAfterMs < 0 || maxRetryAfterMs > 30_000) {
    throw invalid("Invalid GitHub read time bound");
  }

  async function pause(milliseconds: number, scope: ReadScope, status?: number): Promise<void> {
    scope.check();
    if (!Number.isFinite(milliseconds) || milliseconds > maxRetryAfterMs || milliseconds >= scope.remaining()) throw unavailable("GitHub retry delay exceeded the read bound", status);
    try { await scope.run(() => wait(milliseconds, scope.signal)); }
    catch { scope.check(); throw unavailable("GitHub read wait was unavailable", status); }
  }

  async function readJson(path: string, scope: ReadScope, query?: Record<string, string>): Promise<{ payload: unknown; link: string | null; url: string }> {
    const url = buildUrl(baseUrl, path, query);
    for (let attempt = 0; ; attempt += 1) {
      scope.check();
      let response: Response;
      try {
        response = await scope.run(() => fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "x-github-api-version": "2022-11-28",
          },
          redirect: "error",
          cache: "no-store",
          signal: scope.signal,
        }));
      } catch {
        scope.check();
        if (attempt < maxRetries) {
          await pause(250 * 2 ** attempt, scope);
          continue;
        }
        throw new GitHubReadError("github_read_unavailable", "GitHub read request was unavailable");
      }

      const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"));
      const retryable = rateLimited || response.status >= 500;
      if (!response.ok) void response.body?.cancel().catch(() => {});
      if (retryable && attempt < maxRetries) {
        const retryAfter = response.headers.get("retry-after");
        let milliseconds = retryAfter === null ? (rateLimited ? 60_000 : 250 * 2 ** attempt) : retryAfterMilliseconds(retryAfter);
        if (rateLimited && response.headers.get("x-ratelimit-remaining") === "0") {
          const reset = response.headers.get("x-ratelimit-reset");
          if (reset === null || !/^\d+$/.test(reset) || !Number.isSafeInteger(Number(reset) * 1000)) throw unavailable("GitHub returned an invalid rate-limit reset", response.status);
          const resetDelay = Math.max(0, Number(reset) * 1000 - Date.now());
          milliseconds = retryAfter === null ? resetDelay : Math.max(milliseconds, resetDelay);
        }
        await pause(milliseconds, scope, response.status);
        continue;
      }
      if (retryable) throw new GitHubReadError("github_read_unavailable", "GitHub read provider unavailable", response.status);
      if (!response.ok) throw new GitHubReadError("github_read_rejected", "GitHub rejected a read request", response.status);
      return { payload: await readBody(response, scope), link: response.headers.get("link"), url };
    }
  }

  async function repository(owner: string, repo: string, scope: ReadScope): Promise<{ id: string; owner: string; repo: string }> {
    const payload = record((await readJson(`repos/${owner}/${repo}`, scope)).payload);
    if (payload.name !== repo || record(payload.owner).login !== owner || (payload.full_name !== undefined && payload.full_name !== `${owner}/${repo}`)) throw invalid("GitHub repository coordinates changed");
    return { id: parseNumericId(payload.id), owner, repo };
  }

  async function list<T>(path: string, scope: ReadScope, parse: (item: unknown) => T | null, query: Record<string, string> = {}, perPage = 100): Promise<T[]> {
    const records: T[] = [];
    const seen = new Set<string>();
    const seenUrls = new Set<string>();
    let nextAdvertised = false;
    for (let page = 1; page <= MAX_RECONCILIATION_PAGES; page += 1) {
      const response = await readJson(path, scope, { ...query, per_page: String(perPage), page: String(page) });
      if (!Array.isArray(response.payload) || response.payload.length > perPage) throw invalid("GitHub returned an invalid page");
      if (nextAdvertised && response.payload.length === 0) throw unavailable("GitHub advertised page was missing");
      for (const item of response.payload) {
        scope.check();
        const value = record(item);
        const id = parseNumericId(value.id);
        if (seen.has(id)) throw unavailable("GitHub pagination repeated an identity");
        seen.add(id);
        if (typeof value.html_url === "string") {
          if (seenUrls.has(value.html_url)) throw unavailable("GitHub pagination changed an identity");
          seenUrls.add(value.html_url);
        }
        const parsed = parse(item);
        if (parsed !== null) records.push(parsed);
      }
      if (!hasNextPage(response.link, response.url, page, response.payload.length, perPage)) return records;
      nextAdvertised = response.link !== null && response.link.includes('rel="next"');
    }
    throw unavailable("GitHub read exceeded the page bound");
  }

  return {
    async getRepository(input) {
      assertRepository(input.owner, input.repo);
      return boundedRead(readTimeoutMs, input.signal, (scope) => repository(input.owner, input.repo, scope));
    },
    async search(input) {
      assertRepository(input.owner, input.repo);
      if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > 2 || input.queries.some((query) => typeof query !== "string" || !query.trim() || query.length > 200 || /[\r\n]|\b(?:repo|org|user)\s*:|\bOR\b/i.test(query))) {
        throw new GitHubReadError("github_read_invalid", "GitHub search requires one or two bounded queries");
      }
      return boundedRead(readTimeoutMs, input.signal, async (scope) => {
        const results: GitHubCandidate[] = [];
        const seen = new Map<string, GitHubCandidate>();
        for (const query of input.queries) {
          const { payload } = await readJson("search/issues", scope, {
            q: `${query.trim()} repo:${input.owner}/${input.repo}`,
            per_page: String(MAX_CANDIDATES),
            page: "1",
          });
          const search = record(payload);
          if (search.incomplete_results === true) throw unavailable("GitHub search was incomplete");
          if ((search.incomplete_results !== undefined && search.incomplete_results !== false) || !Array.isArray(search.items) || search.items.length > MAX_CANDIDATES) throw invalid("GitHub returned an invalid search response");
          const candidates = search.items.map((item) => parseCandidate(item, input.owner, input.repo, baseUrl));
          for (const candidate of candidates) {
            const previous = seen.get(candidate.id);
            if (previous && previous.htmlUrl !== candidate.htmlUrl) throw invalid("GitHub returned conflicting candidate identities");
            if (!previous) {
              if (results.some((item) => item.htmlUrl === candidate.htmlUrl)) throw invalid("GitHub returned conflicting candidate identities");
              seen.set(candidate.id, candidate);
              results.push(candidate);
            }
            if (results.length === MAX_CANDIDATES) return results;
          }
        }
        return results;
      });
    },

    async getIssue(input) {
      assertRepository(input.owner, input.repo);
      assertIssueNumber(input.issueNumber);
      return boundedRead(readTimeoutMs, input.signal, async (scope) => {
        const { payload } = await readJson(`repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`, scope);
        const candidate = parseCandidate(payload, input.owner, input.repo, baseUrl);
        if (candidate.number !== input.issueNumber) throw invalid("GitHub returned a mismatched issue number");
        return candidate;
      });
    },

    async listIssues(input) {
      assertRepository(input.owner, input.repo);
      return boundedRead(readTimeoutMs, input.signal, (scope) => list(`repos/${input.owner}/${input.repo}/issues`, scope,
        (item) => parseReconciliationIssue(item, input.owner, input.repo, baseUrl), { state: "all", sort: "created", direction: "asc" }));
    },

    async listComments(input) {
      assertRepository(input.owner, input.repo);
      assertIssueNumber(input.issueNumber);
      return boundedRead(readTimeoutMs, input.signal, async (scope) => {
        const { payload } = await readJson(`repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`, scope);
        const parent = parseCandidate(payload, input.owner, input.repo, baseUrl);
        if (parent.number !== input.issueNumber || parent.isPullRequest) throw invalid("GitHub returned a mismatched parent issue");
        return list(`repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`, scope,
          (item) => parseReconciliationComment(item, input.owner, input.repo, input.issueNumber, parent.id, baseUrl));
      });
    },

    async getPullRequestConversation(input) {
      assertRepository(input.owner, input.repo);
      assertIssueNumber(input.pullRequestNumber);
      const repositoryId = parseNumericId(input.repositoryId);
      const expectedPrId = input.pullRequestId === undefined ? undefined : parseNumericId(input.pullRequestId);
      return boundedRead(readTimeoutMs, input.signal, async (scope) => {
        const verifiedRepository = await repository(input.owner, input.repo, scope);
        if (verifiedRepository.id !== repositoryId) throw invalid("GitHub repository identity changed");
        const prPath = `repos/${input.owner}/${input.repo}/pulls/${input.pullRequestNumber}`;
        const issuePath = `repos/${input.owner}/${input.repo}/issues/${input.pullRequestNumber}`;
        const pr = record((await readJson(prPath, scope)).payload);
        const pullRequest = parseCandidate(pr, input.owner, input.repo, baseUrl);
        if (!pullRequest.isPullRequest || pullRequest.number !== input.pullRequestNumber || (expectedPrId !== undefined && pullRequest.id !== expectedPrId)) throw invalid("GitHub returned a mismatched pull request identity");
        assertUrl(pr.url, buildUrl(baseUrl, prPath));
        assertUrl(pr.issue_url, buildUrl(baseUrl, issuePath));
        const baseRepository = record(record(pr.base).repo);
        if (parseNumericId(baseRepository.id) !== repositoryId || baseRepository.name !== input.repo || record(baseRepository.owner).login !== input.owner) throw invalid("GitHub returned a mismatched pull request repository");

        const evidence: GitHubPullRequestEvidence[] = [];
        let characters = pullRequest.title.length;
        let visited = 0;
        const append = (entry: GitHubPullRequestEvidence) => {
          characters += entry.body.length;
          if (characters > MAX_CONVERSATION_CHARACTERS) throw unavailable("GitHub conversation exceeded the context bound");
          evidence.push(entry);
        };
        const common = (item: Record<string, unknown>, kind: GitHubPullRequestEvidence["kind"]) => {
          visited += 1;
          if (visited > MAX_CONVERSATION_RECORDS) throw unavailable("GitHub conversation exceeded the record bound");
          const sourceId = parseNumericId(item.id);
          return {
            id: `${kind}:${sourceId}`, sourceId, permalink: item.html_url as string,
            body: body(item, kind === "pull_request_body"), authorLogin: authorLogin(item),
            createdAt: timestamp(kind === "review" ? item.submitted_at : item.created_at, kind !== "review" || item.state !== "PENDING"),
            updatedAt: timestamp(item.updated_at, kind !== "review"),
          };
        };
        append({ ...common(pr, "pull_request_body"), kind: "pull_request_body" });

        const reviews = new Map<string, string>();
        await list(`${prPath}/reviews`, scope, (value) => {
          const item = record(value);
          const id = parseNumericId(item.id);
          assertUrl(item.pull_request_url, buildUrl(baseUrl, prPath));
          const entry = common(item, "review");
          const state = item.state;
          if (state === "PENDING") { reviews.set(id, state); return null; }
          if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "COMMENTED" && state !== "DISMISSED") throw invalid("GitHub returned an invalid review state");
          assertUrl(item.html_url, `${pullRequest.htmlUrl}#pullrequestreview-${id}`);
          reviews.set(id, state);
          append({ ...entry, kind: "review", reviewState: state });
          return null;
        }, {}, 20);

        let reviewComments = 0;
        await list(`${prPath}/comments`, scope, (value) => {
          const item = record(value);
          const id = parseNumericId(item.id);
          assertUrl(item.pull_request_url, buildUrl(baseUrl, prPath));
          if (item.html_url !== `${pullRequest.htmlUrl}#discussion_r${id}` && item.html_url !== `${pullRequest.htmlUrl}#discussion-diff-${id}`) throw invalid("GitHub returned a mismatched review comment target");
          const entry = common(item, "review_comment");
          const reviewId = item.pull_request_review_id === null ? null : parseNumericId(item.pull_request_review_id);
          if (reviewId !== null && !reviews.has(reviewId)) throw unavailable("GitHub review comment parent was not retrieved");
          reviewComments += 1;
          if (reviewId !== null && reviews.get(reviewId) === "PENDING") return null;
          append({ ...entry, kind: "review_comment", reviewId });
          return null;
        }, {}, 20);

        let issueComments = 0;
        await list(`${issuePath}/comments`, scope, (value) => {
          const item = record(value);
          const id = parseNumericId(item.id);
          assertUrl(item.issue_url, buildUrl(baseUrl, issuePath));
          assertUrl(item.html_url, `${pullRequest.htmlUrl}#issuecomment-${id}`);
          append({ ...common(item, "issue_comment"), kind: "issue_comment" });
          issueComments += 1;
          return null;
        }, {}, 20);
        for (const [expected, actual] of [[pr.comments, issueComments], [pr.review_comments, reviewComments]]) {
          if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== actual)) throw unavailable("GitHub conversation comment counts changed or were incomplete");
        }
        return { repository: verifiedRepository, pullRequest, evidence, complete: true };
      });
    },
  };
}
