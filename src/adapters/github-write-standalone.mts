export interface GitHubCreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  assignees: readonly string[];
  signal?: AbortSignal;
}

export interface GitHubAddCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  signal?: AbortSignal;
}

export interface GitHubIssueResult {
  id: string;
  number: number;
  url: string;
  assignees: string[];
}

export interface GitHubCommentResult {
  id: string;
  url: string;
}

export interface GitHubWriteClient {
  createIssue(input: GitHubCreateIssueInput): Promise<GitHubIssueResult>;
  addProgressComment(input: GitHubAddCommentInput): Promise<GitHubCommentResult>;
}

export interface GitHubWriteClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

type GitHubWriteErrorCode = "invalid_input" | "github_rejected" | "github_unknown";
type GitHubWriteOutcome = "definite_rejection" | "unknown";
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 6_000;

export class GitHubWriteError extends Error {
  readonly code: GitHubWriteErrorCode;
  readonly outcome?: GitHubWriteOutcome;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(
    code: GitHubWriteErrorCode,
    message: string,
    details: { outcome?: GitHubWriteOutcome; status?: number; providerCode?: string } = {},
  ) {
    super(message);
    this.name = "GitHubWriteError";
    this.code = code;
    this.outcome = details.outcome;
    this.status = details.status;
    this.providerCode = details.providerCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProviderSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isGitHubLogin(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

function validateRepository(owner: string, repo: string): void {
  if (!isProviderSegment(owner) || !isProviderSegment(repo)) {
    throw new GitHubWriteError("invalid_input", "GitHub repository coordinates are invalid");
  }
}

function validateIssueInput(input: GitHubCreateIssueInput): void {
  validateRepository(input.owner, input.repo);
  if (
    typeof input.title !== "string" ||
    !input.title ||
    input.title.length > MAX_TITLE_LENGTH ||
    typeof input.body !== "string" ||
    input.body.length > MAX_BODY_LENGTH ||
    !Array.isArray(input.assignees)
  ) {
    throw new GitHubWriteError("invalid_input", "GitHub issue title and body are required");
  }
  if (
    input.assignees.length > 1 ||
    input.assignees.some(
      (assignee) => !isGitHubLogin(assignee),
    )
  ) {
    throw new GitHubWriteError("invalid_input", "At most one valid GitHub assignee is allowed");
  }
}

function validateCommentInput(input: GitHubAddCommentInput): void {
  validateRepository(input.owner, input.repo);
  if (
    !Number.isSafeInteger(input.issueNumber) ||
    input.issueNumber <= 0 ||
    typeof input.body !== "string" ||
    !input.body ||
    input.body.length > MAX_BODY_LENGTH
  ) {
    throw new GitHubWriteError("invalid_input", "GitHub issue number and comment body are required");
  }
}

function pathForIssue(owner: string, repo: string): string {
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

function pathForComment(owner: string, repo: string, issueNumber: number): string {
  return `${pathForIssue(owner, repo)}/${issueNumber}/comments`;
}

function makeUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function providerCode(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.message === "string" ? payload.message : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch {
    throw new GitHubWriteError("github_unknown", "GitHub write outcome is unknown", {
      outcome: "unknown",
    });
  }

  const payload = await readJson(response);
  if (response.status >= 200 && response.status < 300) {
    return payload;
  }

  const definiteRejection = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
  if (definiteRejection) {
    throw new GitHubWriteError("github_rejected", "GitHub rejected the write", {
      outcome: "definite_rejection",
      status: response.status,
      providerCode: providerCode(payload),
    });
  }

  throw new GitHubWriteError("github_unknown", "GitHub write outcome is unknown", {
    outcome: "unknown",
    status: response.status,
    providerCode: providerCode(payload),
  });
}

function parseIdentifier(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value) && value === value.trim()) {
    const numericValue = Number(value);
    if (Number.isSafeInteger(numericValue) && numericValue > 0 && String(numericValue) === value) {
      return value;
    }
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return undefined;
}

function parseIssueResult(payload: unknown): GitHubIssueResult {
  if (
    !isRecord(payload) ||
    !isHttpUrl(payload.html_url) ||
    typeof payload.number !== "number" ||
    !Number.isSafeInteger(payload.number) ||
    payload.number <= 0
  ) {
    throw new GitHubWriteError("github_unknown", "GitHub returned an invalid issue result", {
      outcome: "unknown",
    });
  }

  const id = parseIdentifier(payload.id);
  if (!id || !Array.isArray(payload.assignees)) {
    throw new GitHubWriteError("github_unknown", "GitHub returned an invalid issue identity", {
      outcome: "unknown",
    });
  }

  const assignees: string[] = [];
  for (const assignee of payload.assignees) {
    if (!isRecord(assignee) || !isGitHubLogin(assignee.login)) {
      throw new GitHubWriteError("github_unknown", "GitHub returned an invalid assignee identity", {
        outcome: "unknown",
      });
    }
    assignees.push(assignee.login);
  }

  return { id, number: payload.number, url: payload.html_url, assignees };
}

function parseCommentResult(payload: unknown): GitHubCommentResult {
  if (!isRecord(payload) || !isHttpUrl(payload.html_url)) {
    throw new GitHubWriteError("github_unknown", "GitHub returned an invalid comment result", {
      outcome: "unknown",
    });
  }

  const id = parseIdentifier(payload.id);
  if (!id) {
    throw new GitHubWriteError("github_unknown", "GitHub returned an invalid comment identity", {
      outcome: "unknown",
    });
  }

  return { id, url: payload.html_url };
}

export function createGitHubWriteClient(options: GitHubWriteClientOptions): GitHubWriteClient {
  if (!options.token) {
    throw new GitHubWriteError("invalid_input", "GitHub token is required");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new GitHubWriteError("invalid_input", "Fetch is unavailable in this runtime");
  }

  const baseUrl = options.apiBaseUrl ?? "https://api.github.com";

  return {
    async createIssue(input): Promise<GitHubIssueResult> {
      validateIssueInput(input);
      const payload = await postJson(
        fetchImpl,
        options.token,
        makeUrl(baseUrl, pathForIssue(input.owner, input.repo)),
        { title: input.title, body: input.body, assignees: [...input.assignees] },
        input.signal,
      );
      return parseIssueResult(payload);
    },

    async addProgressComment(input): Promise<GitHubCommentResult> {
      validateCommentInput(input);
      const payload = await postJson(
        fetchImpl,
        options.token,
        makeUrl(baseUrl, pathForComment(input.owner, input.repo, input.issueNumber)),
        { body: input.body },
        input.signal,
      );
      return parseCommentResult(payload);
    },
  };
}
