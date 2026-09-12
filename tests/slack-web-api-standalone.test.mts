import assert from "node:assert/strict";
import test from "node:test";

import { createSlackRepliesClient } from "../src/adapters/slack-web-api-standalone.mts";

test("calls conversations.replies with the injected token and preserves pagination fields", async () => {
  let requestUrl = "";
  let authorization = "";

  const client = createSlackRepliesClient({
    botToken: "xoxb-test",
    apiBaseUrl: "https://slack.test/api",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [{ ts: "1.1", user: "U1", text: "root" }],
          has_more: true,
          response_metadata: { next_cursor: "cursor-2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const page = await client.replies({ channel: "C1", ts: "1.1", limit: 100, cursor: "cursor-1" });

  assert.equal(
    requestUrl,
    "https://slack.test/api/conversations.replies?channel=C1&ts=1.1&limit=100&cursor=cursor-1",
  );
  assert.equal(authorization, "Bearer xoxb-test");
  assert.deepEqual(page, {
    messages: [{ ts: "1.1", user: "U1", text: "root" }],
    has_more: true,
    response_metadata: { next_cursor: "cursor-2" },
  });
});

test("exposes Slack Retry-After as a retryable error without logging the token", async () => {
  const client = createSlackRepliesClient({
    botToken: "xoxb-secret-that-must-not-escape",
    fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": "3" } }),
  });

  await assert.rejects(
    client.replies({ channel: "C1", ts: "1.1", limit: 100 }),
    (error: unknown) => {
      const candidate = error as { code?: string; retryAfterSeconds?: number; message?: string };
      return (
        candidate.code === "slack_rate_limited" &&
        candidate.retryAfterSeconds === 3 &&
        !candidate.message?.includes("xoxb-secret")
      );
    },
  );
});

test("turns an ok:false Slack response into a structured provider error", async () => {
  const client = createSlackRepliesClient({
    botToken: "xoxb-test",
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    client.replies({ channel: "C1", ts: "1.1", limit: 100 }),
    (error: unknown) => {
      const candidate = error as { code?: string; providerCode?: string };
      return candidate.code === "slack_api_error" && candidate.providerCode === "not_in_channel";
    },
  );
});
