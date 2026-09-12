import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySlackEnvelope,
  fetchCompleteSlackThread,
  verifySlackRequestSignature,
} from "../src/adapters/slack-standalone.mts";

const validTimestamp = "1700000000";
const validBody = '{"type":"event_callback","event_id":"Ev1"}';
const validSignature =
  "v0=4780f3e9833499c08e8ad77ce04f80ff8dcfbf802cf0b309feb2dae199b6af21";

test("verifies the exact raw Slack body and rejects stale or altered requests", async () => {
  const valid = await verifySlackRequestSignature({
    signingSecret: "test-secret",
    timestamp: validTimestamp,
    rawBody: validBody,
    signature: validSignature,
    nowMs: Number(validTimestamp) * 1000,
  });

  assert.deepEqual(valid, { ok: true });

  const altered = await verifySlackRequestSignature({
    signingSecret: "test-secret",
    timestamp: validTimestamp,
    rawBody: `${validBody} `,
    signature: validSignature,
    nowMs: Number(validTimestamp) * 1000,
  });

  assert.deepEqual(altered, { ok: false, reason: "invalid_signature" });

  const stale = await verifySlackRequestSignature({
    signingSecret: "test-secret",
    timestamp: validTimestamp,
    rawBody: validBody,
    signature: validSignature,
    nowMs: Number(validTimestamp) * 1000 + 301_000,
  });

  assert.deepEqual(stale, { ok: false, reason: "expired_timestamp" });
});

test("rejects non-finite clock and tolerance overrides even with a valid signature", async () => {
  const base = {
    signingSecret: "test-secret",
    timestamp: validTimestamp,
    rawBody: validBody,
    signature: validSignature,
    nowMs: Number(validTimestamp) * 1000,
  };

  assert.deepEqual(
    await verifySlackRequestSignature({ ...base, nowMs: Number.NaN }),
    { ok: false, reason: "invalid_timestamp" },
  );
  assert.deepEqual(
    await verifySlackRequestSignature({ ...base, toleranceSeconds: Number.POSITIVE_INFINITY }),
    { ok: false, reason: "invalid_timestamp" },
  );
});

test("classifies only permitted app mentions and exposes the invoked thread coordinates", () => {
  const accepted = classifySlackEnvelope(
    {
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev2",
      event: {
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "1700000000.000100",
        text: "<@B1> please review this",
      },
    },
    { botUserId: "B1" },
  );

  assert.deepEqual(accepted, {
    kind: "app_mention",
    teamId: "T1",
    eventId: "Ev2",
    channelId: "C1",
    messageTs: "1700000000.000100",
    threadTs: "1700000000.000100",
    userId: "U1",
    text: "<@B1> please review this",
  });

  assert.deepEqual(
    classifySlackEnvelope({ type: "url_verification", challenge: "challenge-1" }, { botUserId: "B1" }),
    { kind: "challenge", challenge: "challenge-1" },
  );

  const ignored = [
    {
      event: { type: "message", user: "U1", channel: "C1", ts: "1.1" },
      expected: "unsupported_event",
    },
    {
      event: { type: "app_mention", bot_id: "B2", channel: "C1", ts: "1.1" },
      expected: "bot_event",
    },
    {
      event: { type: "app_mention", user: "B1", channel: "C1", ts: "1.1" },
      expected: "self_event",
    },
    {
      event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", is_shared: true },
      expected: "shared_channel",
    },
    {
      event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", is_ext_shared_channel: true },
      expected: "shared_channel",
    },
  ];

  for (const { event, expected } of ignored) {
    const result = classifySlackEnvelope(
      { type: "event_callback", team_id: "T1", event_id: "Ev3", event },
      { botUserId: "B1" },
    );
    assert.deepEqual(result, { kind: "ignore", reason: expected });
  }

  assert.deepEqual(
    classifySlackEnvelope(
      { type: "event_callback", team_id: " ", event_id: "Ev4", event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "hi" } },
      { botUserId: "B1" },
    ),
    { kind: "ignore", reason: "missing_fields" },
  );

  for (const envelope of [
    { team_id: "X1", event_id: "Ev5", event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "hi" } },
    { team_id: "T1", event_id: "Ev6", event: { type: "app_mention", user: "X1", channel: "C1", ts: "1.1", text: "hi" } },
    { team_id: "T1", event_id: "Ev7", event: { type: "app_mention", user: "U1", channel: "X1", ts: "1.1", text: "hi" } },
    { team_id: "T1", event_id: "Ev8", event: { type: "app_mention", user: "U1", channel: "C1", ts: "1", text: "hi" } },
  ]) {
    assert.deepEqual(classifySlackEnvelope({ type: "event_callback", ...envelope }), {
      kind: "ignore",
      reason: "missing_fields",
    });
  }

  assert.deepEqual(
    classifySlackEnvelope(
      { type: "event_callback", team_id: "T1", event_id: "Ev9", event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "hi", is_shared: "true" as unknown as boolean } },
      { botUserId: "B1" },
    ),
    { kind: "ignore", reason: "missing_fields" },
  );
});

test("fetches every thread page, preserves metadata, and excludes bot output from source messages", async () => {
  const calls: unknown[] = [];
  const pages = [
    {
      messages: [
        { ts: "1.1", user: "U1", text: "root" },
        { ts: "1.2", bot_id: "B1", text: "Signal output" },
      ],
      has_more: true,
      response_metadata: { next_cursor: "cursor-2" },
    },
    {
      messages: [{ ts: "1.3", user: "U2", text: "reply", thread_ts: "1.1" }],
      has_more: false,
      response_metadata: { next_cursor: "" },
    },
  ];

  const snapshot = await fetchCompleteSlackThread(
    {
      replies: async (input: unknown) => {
        calls.push(input);
        return pages.shift();
      },
    },
    { channelId: "C1", threadTs: "1.1", botUserId: "B1", maxMessages: 50 },
  );

  assert.equal(snapshot.pageCount, 2);
  assert.deepEqual(snapshot.messages.map((message) => message.ts), ["1.1", "1.2", "1.3"]);
  assert.deepEqual(snapshot.sourceMessages.map((message) => message.ts), ["1.1", "1.3"]);
  assert.deepEqual(calls, [
    { channel: "C1", ts: "1.1", limit: 100 },
    { channel: "C1", ts: "1.1", limit: 100, cursor: "cursor-2" },
  ]);
});

test("rejects overflow and incomplete pagination instead of returning a partial thread", async () => {
  await assert.rejects(
    fetchCompleteSlackThread(
      {
        replies: async () => ({
          messages: [
            { ts: "1.1", user: "U1", text: "one" },
            { ts: "1.2", user: "U1", text: "two" },
            { ts: "1.3", user: "U1", text: "three" },
          ],
          has_more: false,
        }),
      },
      { channelId: "C1", threadTs: "1.1", maxMessages: 2 },
    ),
    (error: unknown) => (error as { code?: string }).code === "thread_overflow",
  );

  await assert.rejects(
    fetchCompleteSlackThread(
      {
        replies: async () => ({
          messages: [{ ts: "1.1", user: "U1", text: "root" }],
          has_more: true,
          response_metadata: {},
        }),
      },
      { channelId: "C1", threadTs: "1.1" },
    ),
    (error: unknown) => (error as { code?: string }).code === "incomplete_thread",
  );

  let cycleCalls = 0;
  await assert.rejects(
    fetchCompleteSlackThread(
      {
        replies: async () => {
          cycleCalls += 1;
          const cursor = cycleCalls === 1 ? "cursor-a" : cycleCalls === 2 ? "cursor-b" : "cursor-a";
          return { messages: [{ ts: `1.${cycleCalls}` }], has_more: true, response_metadata: { next_cursor: cursor } };
        },
      },
      { channelId: "C1", threadTs: "1.1" },
    ),
    (error: unknown) => (error as { code?: string }).code === "incomplete_thread",
  );

  for (const options of [
    { maxMessages: Number.NaN },
    { maxMessages: 51 },
    { pageSize: Number.POSITIVE_INFINITY },
    { maxRateLimitRetries: Number.NaN },
  ]) {
    await assert.rejects(
      fetchCompleteSlackThread(
        { replies: async () => ({ messages: [{ ts: "1.1" }], has_more: false }) },
        options,
      ),
      (error: unknown) => (error as { code?: string }).code === "incomplete_thread",
    );
  }

  for (const page of [
    { messages: [], has_more: false },
    { messages: [{ ts: "1.1" }] },
  ]) {
    await assert.rejects(
      fetchCompleteSlackThread({ replies: async () => page }, { channelId: "C1", threadTs: "1.1" }),
      (error: unknown) => (error as { code?: string }).code === "incomplete_thread",
    );
  }

  let emptyPageAttempts = 0;
  await assert.rejects(
    fetchCompleteSlackThread(
      {
        replies: async () => {
          emptyPageAttempts += 1;
          if (emptyPageAttempts === 1) {
            return undefined;
          }
          throw new Error("stop after the malformed page");
        },
      },
      { channelId: "C1", threadTs: "1.1" },
    ),
    (error: unknown) => (error as { code?: string }).code === "incomplete_thread",
  );
});

test("honors Retry-After through an injected wait and retries the page once", async () => {
  const waits: number[] = [];
  let attempts = 0;

  const snapshot = await fetchCompleteSlackThread(
    {
      replies: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("rate limited"), { retryAfterSeconds: 2 });
        }
        return {
          messages: [{ ts: "1.1", user: "U1", text: "root" }],
          has_more: false,
        };
      },
    },
    {
      channelId: "C1",
      threadTs: "1.1",
      wait: async (milliseconds: number) => waits.push(milliseconds),
      maxRateLimitRetries: 1,
    },
  );

  assert.equal(snapshot.messages.length, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2000]);
});
