import type {
  SlackRepliesPage,
  SlackThreadMessage,
} from "./slack-standalone.mts";

export interface SlackRepliesRequest {
  channel: string;
  ts: string;
  limit: number;
  cursor?: string;
}

export interface SlackWebApiPage {
  messages: SlackThreadMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackRepliesClientOptions {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SlackModalRequest {
  triggerId: string;
  view: unknown;
}

export interface SlackModalClientOptions {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class SlackWebApiError extends Error {
  readonly code: "slack_rate_limited" | "slack_api_error" | "slack_http_error";
  readonly providerCode?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    code: "slack_rate_limited" | "slack_api_error" | "slack_http_error",
    message: string,
    details: { providerCode?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.code = code;
    this.providerCode = details.providerCode;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.name = "SlackWebApiError";
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    return undefined;
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function apiUrl(baseUrl: string, request: SlackRepliesRequest): string {
  const url = new URL("conversations.replies", `${baseUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("channel", request.channel);
  url.searchParams.set("ts", request.ts);
  url.searchParams.set("limit", String(request.limit));
  if (request.cursor) {
    url.searchParams.set("cursor", request.cursor);
  }
  return url.toString();
}

function modalApiUrl(baseUrl: string): string {
  return new URL("views.open", `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function validateModalRequest(request: SlackModalRequest): void {
  if (typeof request.triggerId !== "string" || !request.triggerId.trim() || request.triggerId.length > 256) {
    throw new SlackWebApiError("slack_http_error", "Slack modal trigger is invalid");
  }
  if (typeof request.view !== "object" || request.view === null || Array.isArray(request.view)) {
    throw new SlackWebApiError("slack_http_error", "Slack modal view is invalid");
  }
  const serialized = JSON.stringify(request.view);
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > 50_000) {
    throw new SlackWebApiError("slack_http_error", "Slack modal view is too large");
  }
}

/** Thin wrapper around Slack's views.open endpoint for approval modal display. */
export function createSlackModalClient(options: SlackModalClientOptions) {
  if (!options.botToken) {
    throw new SlackWebApiError("slack_http_error", "Slack bot token is required");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new SlackWebApiError("slack_http_error", "Fetch is unavailable in this runtime");
  }

  const baseUrl = options.apiBaseUrl ?? "https://slack.com/api";

  return {
    async open(request: SlackModalRequest): Promise<{ viewId: string }> {
      validateModalRequest(request);
      let response: Response;
      try {
        response = await fetchImpl(modalApiUrl(baseUrl), {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${options.botToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ trigger_id: request.triggerId, view: request.view }),
        });
      } catch {
        throw new SlackWebApiError("slack_http_error", "Slack modal request was unavailable");
      }

      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      if (response.status === 429) {
        throw new SlackWebApiError("slack_rate_limited", "Slack rate limit exceeded", { retryAfterSeconds });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SlackWebApiError("slack_http_error", "Slack returned invalid JSON");
      }

      if (!response.ok) throw new SlackWebApiError("slack_http_error", "Slack request failed");
      if (typeof payload !== "object" || payload === null || (payload as { ok?: unknown }).ok !== true) {
        const providerCode = typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : undefined;
        throw new SlackWebApiError("slack_api_error", "Slack rejected the modal request", { providerCode });
      }
      const view = (payload as { view?: unknown }).view;
      if (typeof view !== "object" || view === null || typeof (view as { id?: unknown }).id !== "string" || !(view as { id: string }).id.trim()) {
        throw new SlackWebApiError("slack_api_error", "Slack returned an invalid modal response");
      }
      return { viewId: (view as { id: string }).id };
    },
  };
}

/** Thin, read-only wrapper around Slack's conversations.replies endpoint. */
export function createSlackRepliesClient(options: SlackRepliesClientOptions) {
  if (!options.botToken) {
    throw new SlackWebApiError("slack_http_error", "Slack bot token is required");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new SlackWebApiError("slack_http_error", "Fetch is unavailable in this runtime");
  }

  const baseUrl = options.apiBaseUrl ?? "https://slack.com/api";

  return {
    async replies(request: SlackRepliesRequest): Promise<SlackRepliesPage> {
      const response = await fetchImpl(apiUrl(baseUrl, request), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${options.botToken}`,
        },
      });

      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      if (response.status === 429) {
        throw new SlackWebApiError("slack_rate_limited", "Slack rate limit exceeded", {
          retryAfterSeconds,
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SlackWebApiError("slack_http_error", "Slack returned invalid JSON");
      }

      if (!response.ok) {
        throw new SlackWebApiError("slack_http_error", "Slack request failed");
      }

      if (
        typeof payload !== "object" ||
        payload === null ||
        (payload as { ok?: unknown }).ok !== true
      ) {
        const providerCode =
          typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : undefined;
        throw new SlackWebApiError("slack_api_error", "Slack rejected the request", { providerCode });
      }

      const page = payload as Partial<SlackWebApiPage>;
      if (!Array.isArray(page.messages)) {
        throw new SlackWebApiError("slack_api_error", "Slack returned an invalid replies page");
      }

      return {
        messages: page.messages as SlackThreadMessage[],
        has_more: page.has_more,
        response_metadata: page.response_metadata,
      };
    },
  };
}
