import type { SlackBlock } from "../services/proposal-card";
import type { ApprovalModal, ApprovalNoticeModal } from "../services/approve";
import type { ResultNotification, SlackResultClient } from "../services/notify";
import type { CompleteSlackThread, SlackThreadMessage } from "./slack-standalone.mts";

type ErrorCode = "slack_api_error" | "slack_auth_error" | "slack_rate_limited" | "slack_http_error" |
  "slack_transport_error" | "slack_invalid_response" | "slack_invalid_input" | "slack_deadline_exceeded" |
  "slack_aborted" | "slack_post_ambiguous" | "slack_channel_unavailable" | "thread_overflow" | "incomplete_thread";

const AUTH_ERRORS = new Set(["not_authed", "invalid_auth", "token_revoked", "account_inactive", "missing_scope", "no_permission", "access_denied"]);
const TRANSIENT_ERRORS = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout"]);
const PROVIDER_CODES = new Set([...AUTH_ERRORS, ...TRANSIENT_ERRORS, "ratelimited", "rate_limited", "channel_not_found", "not_in_channel", "is_archived", "thread_not_found", "message_not_found", "cant_update_message", "invalid_arguments", "invalid_blocks", "msg_too_long", "invalid_trigger", "expired_trigger_id"]);
const CHANNEL_ID = /^[CG][A-Z0-9]{1,63}$/;
const TIMESTAMP = /^\d{1,16}\.\d{1,6}$/;
const MAX_RESPONSE_BYTES = 1_048_576;

export class SlackApiError extends Error {
  readonly providerCode?: string;
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(message: string, providerCode?: string, details: { code?: ErrorCode; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "SlackApiError";
    this.providerCode = providerCode && PROVIDER_CODES.has(providerCode) ? providerCode : undefined;
    this.code = details.code ?? "slack_api_error";
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

export interface SlackApiClient extends SlackResultClient {
  openModal(input: { triggerId: string; modal: ApprovalModal | ApprovalNoticeModal }): Promise<{ viewId: string }>;
  postMessage(input: { channelId: string; threadTs: string; text: string; blocks: SlackBlock[] }): Promise<{ messageTs: string }>;
}

export interface SlackTransportOptions {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Whole operation budget, including response bodies, pagination and waits; at most 30s. */
  timeoutMs?: number;
  /** Only reads and chat.update retry. At most three attempts per request. */
  maxAttempts?: number;
  maxRetryWaitMs?: number;
  signal?: AbortSignal;
}

type Budget = { signal: AbortSignal; expiresAt: number };

function failure(code: ErrorCode): SlackApiError {
  // Codes and messages are application constants; never retain a provider response/cause.
  return new SlackApiError(code, undefined, { code });
}

function active(budget: Budget): void {
  if (budget.signal.aborted) throw budget.signal.reason as SlackApiError;
  if (performance.now() >= budget.expiresAt) throw failure("slack_deadline_exceeded");
}

async function bounded<T>(timeoutMs: number, parent: AbortSignal | undefined, run: (budget: Budget) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(failure("slack_aborted"));
  if (parent?.aborted) throw failure("slack_aborted");
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(failure("slack_deadline_exceeded")), timeoutMs);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    // The race bounds injected/non-cooperative fetch implementations as well as native fetch.
    return await Promise.race([run({ signal: controller.signal, expiresAt: performance.now() + timeoutMs }), aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort(failure("slack_aborted"));
  }
}

async function wait(milliseconds: number, budget: Budget): Promise<void> {
  active(budget);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(budget.signal.reason); };
    const timer = setTimeout(() => { budget.signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    budget.signal.addEventListener("abort", abort, { once: true });
  });
  active(budget);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function target(channelId: string, ts: string): void {
  if (!matches(channelId, CHANNEL_ID) || !matches(ts, TIMESTAMP)) throw failure("slack_invalid_input");
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.length > 32 || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 && Number.isSafeInteger(Math.ceil(seconds * 1000)) ? seconds : undefined;
}

function discard(response: Response): void {
  // Do not wait for an untrusted/never-ending error response to drain.
  void response.body?.cancel().catch(() => {});
}

async function readJson(response: Response, budget: Budget): Promise<Record<string, unknown>> {
  if (!response.body) throw failure("slack_invalid_response");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  budget.signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      active(budget);
      const chunk = await reader.read();
      active(budget);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw failure("slack_invalid_response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const payload: unknown = JSON.parse(text);
    if (!record(payload) || typeof payload.ok !== "boolean") throw failure("slack_invalid_response");
    return payload;
  } catch (error) {
    active(budget);
    if (error instanceof SlackApiError) throw error;
    throw failure("slack_invalid_response");
  } finally {
    budget.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function transport(options: SlackTransportOptions, defaultTimeout = 10_000) {
  if (typeof options.botToken !== "string" || !options.botToken.trim() || /[\r\n]/.test(options.botToken)) throw failure("slack_invalid_input");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw failure("slack_invalid_input");
  const timeoutMs = options.timeoutMs ?? defaultTimeout;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
      !Number.isSafeInteger(maxRetryWaitMs) || maxRetryWaitMs < 0 || maxRetryWaitMs > 10_000) throw failure("slack_invalid_input");
  let baseUrl: URL;
  try {
    baseUrl = new URL(`${(options.apiBaseUrl ?? "https://slack.com/api").replace(/\/$/, "")}/`);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw failure("slack_invalid_input");
  } catch { throw failure("slack_invalid_input"); }

  async function call(method: string, body: Record<string, unknown>, budget: Budget, safeRetry: boolean, read = false): Promise<Record<string, unknown>> {
    const url = new URL(method, baseUrl);
    let serialized: string | undefined;
    try {
      if (read) for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
      else serialized = JSON.stringify(body);
    } catch { throw failure("slack_invalid_input"); }
    for (let attempt = 1; ; attempt += 1) {
      active(budget);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url.toString(), {
            method: read ? "GET" : "POST", redirect: "error", cache: "no-store", signal: budget.signal,
            headers: { accept: "application/json", authorization: `Bearer ${options.botToken}`, ...(read ? {} : { "content-type": "application/json" }) },
            ...(serialized === undefined ? {} : { body: serialized }),
          });
        } catch { active(budget); throw failure("slack_transport_error"); }
        if (budget.signal.aborted) discard(response);
        active(budget);
        const retryAfterSeconds = retryAfter(response);
        if (!response.ok) {
          discard(response);
          const code = response.status === 429 ? "slack_rate_limited" :
            response.status === 401 || response.status === 403 ? "slack_auth_error" :
              response.status >= 500 || response.status === 408 ? "slack_http_error" : "slack_api_error";
          throw new SlackApiError(code, undefined, { code, retryAfterSeconds });
        }
        const payload = await readJson(response, budget);
        if (payload.ok !== true) {
          const providerCode = typeof payload.error === "string" && PROVIDER_CODES.has(payload.error) ? payload.error : undefined;
          const code = providerCode && AUTH_ERRORS.has(providerCode) ? "slack_auth_error" :
            providerCode === "ratelimited" || providerCode === "rate_limited" ? "slack_rate_limited" :
              providerCode && TRANSIENT_ERRORS.has(providerCode) ? "slack_http_error" : "slack_api_error";
          throw new SlackApiError(code, providerCode, { code, retryAfterSeconds });
        }
        return payload;
      } catch (error) {
        active(budget);
        const safe = error instanceof SlackApiError ? error : failure("slack_transport_error");
        const retryable = ["slack_rate_limited", "slack_http_error", "slack_transport_error"].includes(safe.code);
        if (!safeRetry || !retryable || attempt >= maxAttempts) throw safe;
        if (safe.code === "slack_rate_limited" && safe.retryAfterSeconds === undefined) throw safe;
        const delay = safe.retryAfterSeconds === undefined ? 250 * 2 ** (attempt - 1) : Math.ceil(safe.retryAfterSeconds * 1000);
        // Never clamp Retry-After downward and accidentally retry before Slack permits it.
        if (delay > maxRetryWaitMs || delay >= budget.expiresAt - performance.now()) throw safe;
        await wait(delay, budget);
      }
    }
  }
  return { call, run: <T>(fn: (budget: Budget) => Promise<T>, cap = timeoutMs) => bounded(Math.min(timeoutMs, cap), options.signal, fn) };
}

export function createSlackApiClient(options: SlackTransportOptions): SlackApiClient {
  const api = transport(options);
  return {
    async openModal(input) {
      if (typeof input.triggerId !== "string" || !input.triggerId.trim() || input.triggerId.length > 512) throw failure("slack_invalid_input");
      return api.run(async (budget) => {
        const payload = await api.call("views.open", { trigger_id: input.triggerId, view: input.modal }, budget, false);
        if (!record(payload.view) || !matches(payload.view.id, /^V[A-Z0-9]{1,63}$/)) throw failure("slack_invalid_response");
        return { viewId: payload.view.id };
      }, 2_500);
    },
    async updateMessage(input: ResultNotification) {
      target(input.channelId, input.messageTs);
      await api.run(async (budget) => {
        // This retry only replaces this persisted Slack message; it has no GitHub capability.
        const payload = await api.call("chat.update", { channel: input.channelId, ts: input.messageTs, text: input.text }, budget, true);
        if (payload.channel !== input.channelId || payload.ts !== input.messageTs) throw failure("slack_invalid_response");
      });
    },
    async postMessage(input) {
      target(input.channelId, input.threadTs);
      let started = false;
      try {
        return await api.run(async (budget) => {
          active(budget);
          started = true;
          // One attempt only. client_msg_id is not a documented exactly-once contract.
          const payload = await api.call("chat.postMessage", { channel: input.channelId, thread_ts: input.threadTs, text: input.text, blocks: input.blocks, unfurl_links: false, unfurl_media: false }, budget, false);
          if (payload.channel !== input.channelId || !matches(payload.ts, TIMESTAMP) || !record(payload.message) ||
              payload.message.ts !== payload.ts || payload.message.thread_ts !== input.threadTs) throw failure("slack_invalid_response");
          return { messageTs: payload.ts };
        });
      } catch (error) {
        const safe = error instanceof SlackApiError ? error : failure("slack_transport_error");
        if (started && (safe.code === "slack_transport_error" || safe.code === "slack_http_error" ||
            safe.code === "slack_deadline_exceeded" || safe.code === "slack_aborted" || safe.code === "slack_invalid_response" ||
            (safe.code === "slack_api_error" && !safe.providerCode))) throw failure("slack_post_ambiguous");
        throw safe;
      }
    },
  };
}

export interface SlackThreadReadInput {
  channelId: string;
  threadTs: string;
  botUserId?: string;
  botAppId?: string;
  maxMessages?: number;
  pageSize?: number;
}

function checkChannel(value: unknown, channelId: string): void {
  if (!record(value) || value.id !== channelId || value.is_shared !== false || value.is_ext_shared !== false ||
      value.is_im !== false || value.is_mpim !== false || value.is_archived !== false || value.is_member !== true ||
      (value.is_org_shared !== undefined && value.is_org_shared !== false) ||
      (value.is_pending_ext_shared !== undefined && value.is_pending_ext_shared !== false) ||
      (value.pending_shared !== undefined && (!Array.isArray(value.pending_shared) || value.pending_shared.length > 0))) {
    throw failure("slack_channel_unavailable");
  }
}

function threadMessage(value: unknown, input: SlackThreadReadInput): SlackThreadMessage {
  if (!record(value) || !matches(value.ts, TIMESTAMP) ||
      (value.ts !== input.threadTs && value.thread_ts !== input.threadTs) ||
      (value.thread_ts !== undefined && value.thread_ts !== input.threadTs) ||
      (value.channel !== undefined && value.channel !== input.channelId) ||
      (value.text !== undefined && typeof value.text !== "string")) throw failure("incomplete_thread");
  const result: SlackThreadMessage = { ts: value.ts };
  // Project only fields used by analysis; discard arbitrary response metadata/URLs.
  for (const [key, pattern] of [["user", /^[UW][A-Z0-9]{1,63}$/], ["bot_id", /^B[A-Z0-9]{1,63}$/], ["app_id", /^A[A-Z0-9]{1,63}$/]] as const) {
    if (value[key] !== undefined) {
      if (!matches(value[key], pattern)) throw failure("incomplete_thread");
      result[key] = value[key];
    }
  }
  if (value.text !== undefined) result.text = value.text as string;
  if (value.thread_ts !== undefined) result.thread_ts = input.threadTs;
  if (value.subtype !== undefined) {
    if (!matches(value.subtype, /^[a-z_]{1,64}$/)) throw failure("incomplete_thread");
    result.subtype = value.subtype;
  }
  if (value.edited !== undefined) {
    if (!record(value.edited) || !matches(value.edited.ts, TIMESTAMP)) throw failure("incomplete_thread");
    result.edited = { ts: value.edited.ts };
  }
  if (value.reply_count !== undefined) {
    if (!Number.isSafeInteger(value.reply_count) || (value.reply_count as number) < 0) throw failure("incomplete_thread");
    result.reply_count = value.reply_count;
  }
  if (!result.user && !result.bot_id) throw failure("incomplete_thread");
  return result;
}

function checkedPermalink(value: unknown, channelId: string, ts: string, threadTs: string): string {
  if (typeof value !== "string" || value.length > 2_048 || /[\s<>|\\]/.test(value)) throw failure("slack_invalid_response");
  let url: URL;
  try { url = new URL(value); } catch { throw failure("slack_invalid_response"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !(url.hostname === "slack.com" || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.slack\.com$/.test(url.hostname)) ||
      url.pathname !== `/archives/${channelId}/p${ts.replace(".", "")}`) throw failure("slack_invalid_response");
  for (const [key, val] of url.searchParams) {
    if ((key !== "thread_ts" && key !== "cid") || url.searchParams.getAll(key).length !== 1 ||
        (key === "thread_ts" ? val !== threadTs : val !== channelId)) throw failure("slack_invalid_response");
  }
  return url.toString();
}

/** Additive read path: caller must first resolve an allowlisted, tenant-owned channel. */
export function createSlackThreadClient(options: SlackTransportOptions): { fetchThread(input: SlackThreadReadInput): Promise<CompleteSlackThread> } {
  const api = transport(options, 30_000);
  return {
    async fetchThread(input) {
      target(input.channelId, input.threadTs);
      const maxMessages = input.maxMessages ?? 50;
      const pageSize = input.pageSize ?? 100;
      if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 50 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw failure("slack_invalid_input");
      return api.run(async (budget) => {
        const info = await api.call("conversations.info", { channel: input.channelId }, budget, true, true);
        checkChannel(info.channel, input.channelId);
        const messages: SlackThreadMessage[] = [];
        const seen = new Map<string, string>();
        const cursors = new Set<string>();
        let cursor = "";
        let pageCount = 0;
        let sourceBytes = 0;
        for (;;) {
          if (pageCount >= maxMessages) throw failure("incomplete_thread");
          const page = await api.call("conversations.replies", { channel: input.channelId, ts: input.threadTs, limit: pageSize, ...(cursor ? { cursor } : {}) }, budget, true, true);
          if (!Array.isArray(page.messages) || page.messages.length === 0 || page.messages.length > pageSize ||
              (page.has_more !== undefined && typeof page.has_more !== "boolean") ||
              (page.response_metadata !== undefined && !record(page.response_metadata))) throw failure("incomplete_thread");
          pageCount += 1;
          const previousCount = messages.length;
          for (const value of page.messages) {
            const message = threadMessage(value, input);
            if (message.ts === input.threadTs && typeof message.reply_count === "number" && message.reply_count >= maxMessages) throw failure("thread_overflow");
            const signature = JSON.stringify(message);
            if (seen.has(message.ts)) {
              if (seen.get(message.ts) !== signature) throw failure("incomplete_thread");
              continue;
            }
            seen.set(message.ts, signature);
            messages.push(message);
            sourceBytes += new TextEncoder().encode(signature).byteLength;
            if (messages.length > maxMessages || sourceBytes > MAX_RESPONSE_BYTES) throw failure("thread_overflow");
          }
          if (messages.length === previousCount) throw failure("incomplete_thread");
          const next = record(page.response_metadata) ? page.response_metadata.next_cursor : undefined;
          if (next !== undefined && (typeof next !== "string" || next.length > 2_048 || /\s/.test(next))) throw failure("incomplete_thread");
          const nextCursor = typeof next === "string" ? next : "";
          if (page.has_more === true && !nextCursor) throw failure("incomplete_thread");
          if (!nextCursor) {
            // Missing has_more is allowed only with Slack's explicit terminal cursor.
            if (page.has_more !== false && next !== "") throw failure("incomplete_thread");
            break;
          }
          if (cursors.has(nextCursor)) throw failure("incomplete_thread");
          cursors.add(nextCursor);
          cursor = nextCursor;
        }
        if (!seen.has(input.threadTs)) throw failure("incomplete_thread");
        const root = messages.find((message) => message.ts === input.threadTs)!;
        if (typeof root.reply_count === "number" && root.reply_count !== messages.length - 1) throw failure("incomplete_thread");
        messages.sort((left, right) => {
          const comparable = (ts: string) => { const [seconds, micros] = ts.split("."); return BigInt(seconds) * BigInt(1_000_000) + BigInt(micros.padEnd(6, "0")); };
          const a = comparable(left.ts); const b = comparable(right.ts);
          return a < b ? -1 : a > b ? 1 : 0;
        });
        const sourceMessages = messages.filter((message) => !message.bot_id && message.subtype !== "bot_message" &&
          !(input.botUserId && message.user === input.botUserId) && !(input.botAppId && message.app_id === input.botAppId));
        for (const message of sourceMessages) {
          const payload = await api.call("chat.getPermalink", { channel: input.channelId, message_ts: message.ts }, budget, true, true);
          message.permalink = checkedPermalink(payload.permalink, input.channelId, message.ts, input.threadTs);
        }
        return { channelId: input.channelId, threadTs: input.threadTs, pageCount, messages, sourceMessages };
      });
    },
  };
}

// The existing public/private channel reader, mentions and review cards need
// these bot permissions. No user, DM, admin, join or public-posting authority.
export const SLACK_CONNECTION_SCOPES: readonly string[] = Object.freeze([
  "app_mentions:read", "channels:history", "channels:read", "chat:write", "groups:history", "groups:read",
]);
export interface SlackOAuthOptions {
  clientId: string;
  appId: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SlackOAuthCodeInput {
  code: string;
  pkceVerifier: string;
  expectedTeamId?: string;
  expectedBotUserId?: string;
}
/** Internal server transport result. Only the connection service may seal the
 * token and project safe metadata; never serialize this object. */
export interface VerifiedSlackOAuth {
  teamId: string;
  botUserId: string;
  displayName: string;
  scopes: string[];
  botToken: string;
}

const TEAM_ID = /^T[A-Z0-9]{1,63}$/;
const USER_ID = /^[UW][A-Z0-9]{1,63}$/;

function workspaceName(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && value === value.trim() && value.length > 0 && value.length <= 120
    && !/[<>]/.test(value) && ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

/** PKCE-only web OAuth: Slack documents omitting client_secret for this flow.
 * No endpoint override and no retry of the single-use code exchange. */
export async function exchangeSlackOAuthCode(options: SlackOAuthOptions, input: SlackOAuthCodeInput): Promise<VerifiedSlackOAuth> {
  try {
    // Lazy boundary preserves the existing adapter's standalone Node consumers,
    // while preventing this credential-bearing path from entering client code.
    await import("server-only");
    if (typeof window !== "undefined") throw new Error();
    const redirectUri = new URL(options.redirectUri);
    if (!matches(options.clientId, /^\d{1,32}\.\d{1,32}$/) || !matches(options.appId, /^A[A-Z0-9]{1,63}$/)
      || redirectUri.protocol !== "https:" || redirectUri.username || redirectUri.password || redirectUri.search || redirectUri.hash
      || redirectUri.pathname !== "/api/settings/connections/slack/callback"
      || ["localhost", "127.0.0.1", "[::1]"].includes(redirectUri.hostname)
      || !matches(input.code, /^[A-Za-z0-9._~-]{1,2048}$/) || !matches(input.pkceVerifier, /^[A-Za-z0-9._~-]{43,128}$/)
      || (input.expectedTeamId !== undefined && !matches(input.expectedTeamId, TEAM_ID))
      || (input.expectedBotUserId !== undefined && !matches(input.expectedBotUserId, USER_ID))) throw new Error();
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    return await bounded(timeoutMs, options.signal, async (budget) => {
      async function call(method: "oauth.v2.access" | "auth.test", body: URLSearchParams, botToken?: string) {
        active(budget);
        const response = await fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST", body: body.toString(), redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
          credentials: "omit", signal: budget.signal,
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...(botToken ? { authorization: `Bearer ${botToken}` } : {}) },
        });
        if (budget.signal.aborted || !response.ok || response.redirected) { discard(response); throw new Error(); }
        active(budget);
        const payload = await readJson(response, budget);
        if (payload.ok !== true) throw new Error();
        return payload;
      }
      const payload = await call("oauth.v2.access", new URLSearchParams({
        client_id: options.clientId, code: input.code, code_verifier: input.pkceVerifier,
        redirect_uri: options.redirectUri, grant_type: "authorization_code",
      }));
      if (payload.token_type !== "bot" || !matches(payload.access_token, /^xoxb-[A-Za-z0-9-]{1,4096}$/)
        || payload.app_id !== options.appId || !matches(payload.bot_user_id, USER_ID)
        || !record(payload.team) || !matches(payload.team.id, TEAM_ID) || !workspaceName(payload.team.name)
        || payload.team.name.includes(payload.access_token)
        || (input.expectedTeamId !== undefined && payload.team.id !== input.expectedTeamId)
        || (input.expectedBotUserId !== undefined && payload.bot_user_id !== input.expectedBotUserId)
        || (payload.is_enterprise_install !== undefined && payload.is_enterprise_install !== false)
        || payload.refresh_token !== undefined || payload.expires_in !== undefined || payload.incoming_webhook !== undefined
        || !record(payload.authed_user) || !matches(payload.authed_user.id, USER_ID)
        || payload.authed_user.access_token !== undefined || payload.authed_user.refresh_token !== undefined
        || payload.authed_user.token_type !== undefined || (payload.authed_user.scope !== undefined && payload.authed_user.scope !== "")
        || typeof payload.scope !== "string" || payload.scope.length > 2048) throw new Error();
      const scopes = payload.scope.split(",").map((scope) => scope.trim()).sort();
      if (scopes.length !== SLACK_CONNECTION_SCOPES.length || scopes.some((scope, index) => scope !== SLACK_CONNECTION_SCOPES[index])) throw new Error();
      const enterpriseId = payload.enterprise == null ? undefined : record(payload.enterprise) ? payload.enterprise.id : null;
      if (enterpriseId !== undefined && !matches(enterpriseId, /^E[A-Z0-9]{1,63}$/)) throw new Error();
      const identity = await call("auth.test", new URLSearchParams(), payload.access_token);
      if (identity.team_id !== payload.team.id || identity.user_id !== payload.bot_user_id || !matches(identity.bot_id, /^B[A-Z0-9]{1,63}$/)
        || (identity.enterprise_id ?? undefined) !== enterpriseId
        || (identity.is_enterprise_install !== undefined && identity.is_enterprise_install !== false)) throw new Error();
      return { teamId: payload.team.id, botUserId: payload.bot_user_id, displayName: payload.team.name, scopes, botToken: payload.access_token };
    });
  } catch {
    // Never attach the response, request body, token, provider code or cause.
    throw failure("slack_auth_error");
  }
}
