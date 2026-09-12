export type SlackSignatureFailure =
  | "missing_secret"
  | "invalid_timestamp"
  | "expired_timestamp"
  | "invalid_signature";

export type SlackSignatureResult =
  | { ok: true }
  | { ok: false; reason: SlackSignatureFailure };

export interface VerifySlackRequestInput {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  nowMs?: number;
  toleranceSeconds?: number;
}

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

function constantTimeEqualText(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Verifies Slack's v0 signature against the original, unparsed request body. */
export async function verifySlackRequestSignature(
  input: VerifySlackRequestInput,
): Promise<SlackSignatureResult> {
  if (!input.signingSecret) {
    return { ok: false, reason: "missing_secret" };
  }

  if (!/^\d+$/.test(input.timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const timestampSeconds = Number(input.timestamp);
  const nowMs = input.nowMs ?? Date.now();
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;

  if (
    !Number.isSafeInteger(timestampSeconds) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0
  ) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (Math.abs(nowMs - timestampSeconds * 1000) > toleranceSeconds * 1000) {
    return { ok: false, reason: "expired_timestamp" };
  }

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${input.timestamp}:${input.rawBody}`),
  );
  const expectedSignature = `v0=${bytesToHex(new Uint8Array(digest))}`;

  return constantTimeEqualText(expectedSignature, input.signature)
    ? { ok: true }
    : { ok: false, reason: "invalid_signature" };
}

export interface SlackEvent {
  type?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  is_shared?: boolean;
  is_ext_shared_channel?: boolean;
  ts?: string;
  thread_ts?: string;
  text?: string;
}

export interface SlackEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  is_ext_shared_channel?: boolean;
  event?: SlackEvent;
}

export type SlackEnvelopeClassification =
  | { kind: "challenge"; challenge: string }
  | {
      kind: "app_mention";
      teamId: string;
      eventId: string;
      channelId: string;
      messageTs: string;
      threadTs: string;
      userId: string;
      text: string;
    }
  | {
      kind: "ignore";
      reason:
        | "unsupported_event"
        | "bot_event"
        | "self_event"
        | "shared_channel"
        | "missing_fields";
    };

export function classifySlackEnvelope(
  envelope: SlackEnvelope,
  options: { botUserId?: string } = {},
): SlackEnvelopeClassification {
  if (envelope.type === "url_verification" && envelope.challenge) {
    return { kind: "challenge", challenge: envelope.challenge };
  }

  const event = envelope.event;
  if (envelope.type !== "event_callback" || event?.type !== "app_mention") {
    return { kind: "ignore", reason: "unsupported_event" };
  }

  if (event.bot_id || event.subtype === "bot_message") {
    return { kind: "ignore", reason: "bot_event" };
  }

  if (options.botUserId && event.user === options.botUserId) {
    return { kind: "ignore", reason: "self_event" };
  }

  if (
    event.is_shared === true ||
    event.is_ext_shared_channel === true ||
    envelope.is_ext_shared_channel === true ||
    event.channel_type === "shared"
  ) {
    return { kind: "ignore", reason: "shared_channel" };
  }

  const threadTs = event.thread_ts ?? event.ts;
  if (
    typeof envelope.team_id !== "string" ||
    !envelope.team_id.trim() ||
    typeof envelope.event_id !== "string" ||
    !envelope.event_id.trim() ||
    typeof event.channel !== "string" ||
    !event.channel.trim() ||
    typeof event.ts !== "string" ||
    !/^\d+\.\d+$/.test(event.ts) ||
    typeof threadTs !== "string" ||
    !/^\d+\.\d+$/.test(threadTs) ||
    typeof event.user !== "string" ||
    !event.user.trim() ||
    typeof event.text !== "string"
  ) {
    return { kind: "ignore", reason: "missing_fields" };
  }

  return {
    kind: "app_mention",
    teamId: envelope.team_id,
    eventId: envelope.event_id,
    channelId: event.channel,
    messageTs: event.ts,
    threadTs,
    userId: event.user,
    text: event.text,
  };
}

export interface SlackThreadMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  text?: string;
  [key: string]: unknown;
}

export interface SlackRepliesPage {
  messages: SlackThreadMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackRepliesClient {
  replies(input: {
    channel: string;
    ts: string;
    limit: number;
    cursor?: string;
  }): Promise<SlackRepliesPage | undefined>;
}

export interface CompleteSlackThread {
  channelId: string;
  threadTs: string;
  pageCount: number;
  messages: SlackThreadMessage[];
  sourceMessages: SlackThreadMessage[];
}

export interface FetchSlackThreadOptions {
  channelId: string;
  threadTs: string;
  botUserId?: string;
  botAppId?: string;
  maxMessages?: number;
  pageSize?: number;
  maxRateLimitRetries?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export class SlackThreadError extends Error {
  readonly code: "thread_overflow" | "incomplete_thread" | "rate_limit_exhausted";

  constructor(
    code: "thread_overflow" | "incomplete_thread" | "rate_limit_exhausted",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "SlackThreadError";
  }
}

function retryAfterMilliseconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("retryAfterSeconds" in error)) {
    return undefined;
  }

  const retryAfterSeconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1000
    : undefined;
}

function isBotOutput(message: SlackThreadMessage, options: FetchSlackThreadOptions): boolean {
  return Boolean(
    message.bot_id ||
      message.subtype === "bot_message" ||
      (options.botUserId && message.user === options.botUserId) ||
      (options.botAppId && message.app_id === options.botAppId),
  );
}

export async function fetchCompleteSlackThread(
  client: SlackRepliesClient,
  options: FetchSlackThreadOptions,
): Promise<CompleteSlackThread> {
  const maxMessages = options.maxMessages ?? 50;
  const requestedPageSize = options.pageSize ?? 100;
  const pageSize = requestedPageSize;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
  const wait = options.wait ?? (async (milliseconds: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });

  if (
    !Number.isSafeInteger(maxMessages) ||
    maxMessages < 1 ||
    maxMessages > 50 ||
    !Number.isSafeInteger(requestedPageSize) ||
    requestedPageSize < 1 ||
    requestedPageSize > 100 ||
    !Number.isSafeInteger(maxRateLimitRetries) ||
    maxRateLimitRetries < 0 ||
    maxRateLimitRetries > 3
  ) {
    throw new SlackThreadError("incomplete_thread", "Invalid thread fetch limits");
  }

  const messages: SlackThreadMessage[] = [];
  const seenMessageTs = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  let hasMore = true;

  while (hasMore) {
    const request = {
      channel: options.channelId,
      ts: options.threadTs,
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    };
    let page: SlackRepliesPage;
    let rateLimitRetries = 0;

    while (true) {
      try {
        const response = await client.replies(request);
        if (!response) {
          throw new SlackThreadError("incomplete_thread", "Slack returned an empty page");
        }
        page = response;
        break;
      } catch (error) {
        const retryAfter = retryAfterMilliseconds(error);
        if (retryAfter === undefined || rateLimitRetries >= maxRateLimitRetries) {
          if (retryAfter !== undefined) {
            throw new SlackThreadError("rate_limit_exhausted", "Slack rate limit retries exhausted");
          }
          throw error;
        }

        rateLimitRetries += 1;
        await wait(retryAfter);
      }
    }

    if (!Array.isArray(page.messages) || page.messages.length === 0 || typeof page.has_more !== "boolean") {
      throw new SlackThreadError("incomplete_thread", "Slack returned an incomplete page");
    }

    pageCount += 1;
    for (const message of page.messages) {
      if (!message || typeof message.ts !== "string" || !message.ts) {
        throw new SlackThreadError("incomplete_thread", "Slack returned a message without a timestamp");
      }

      if (!seenMessageTs.has(message.ts)) {
        seenMessageTs.add(message.ts);
        messages.push(message);
      }

      if (messages.length > maxMessages) {
        throw new SlackThreadError("thread_overflow", "Slack thread exceeds the configured message cap");
      }
    }

    const nextCursor = page.response_metadata?.next_cursor?.trim() || undefined;
    if (page.has_more === true && !nextCursor) {
      throw new SlackThreadError("incomplete_thread", "Slack indicated another page without a cursor");
    }

    if (nextCursor && nextCursor === cursor) {
      throw new SlackThreadError("incomplete_thread", "Slack repeated the pagination cursor");
    }

    cursor = nextCursor;
    hasMore = Boolean(nextCursor) || page.has_more === true;
  }

  return {
    channelId: options.channelId,
    threadTs: options.threadTs,
    pageCount,
    messages,
    sourceMessages: messages.filter((message) => !isBotOutput(message, options)),
  };
}
