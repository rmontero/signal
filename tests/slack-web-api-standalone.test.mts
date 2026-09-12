import assert from "node:assert/strict";
import test from "node:test";

import { createSlackModalClient, createSlackRepliesClient } from "../src/adapters/slack-web-api-standalone.mts";

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

test("opens a Slack modal with the exact trigger and rendered view, returning the provider view id", async () => {
  let requestUrl = "";
  let requestBody = "";
  let authorization = "";
  let contentType = "";
  const client = createSlackModalClient({
    botToken: "xoxb-test",
    apiBaseUrl: "https://slack.test/api",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization") ?? "";
      contentType = headers.get("content-type") ?? "";
      return new Response(JSON.stringify({ ok: true, view: { id: "V123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const view = { type: "modal", callback_id: "signal.approve_proposal", private_metadata: "opaque" };

  const result = await client.open({ triggerId: "1337.1", view });

  assert.deepEqual(result, { viewId: "V123" });
  assert.equal(requestUrl, "https://slack.test/api/views.open");
  assert.equal(authorization, "Bearer xoxb-test");
  assert.equal(contentType, "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(requestBody), { trigger_id: "1337.1", view });
});

test("classifies Slack modal rate limits and malformed successful responses", async () => {
  const rateLimited = createSlackModalClient({
    botToken: "xoxb-secret-that-must-not-escape",
    fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": "4" } }),
  });
  await assert.rejects(
    rateLimited.open({ triggerId: "1337.1", view: { type: "modal" } }),
    (error: unknown) => {
      const candidate = error as { code?: string; retryAfterSeconds?: number; message?: string };
      return candidate.code === "slack_rate_limited" && candidate.retryAfterSeconds === 4 && !candidate.message?.includes("xoxb-secret");
    },
  );

  const malformed = createSlackModalClient({
    botToken: "xoxb-test",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, view: {} }), { status: 200 }),
  });
  await assert.rejects(
    malformed.open({ triggerId: "1337.1", view: { type: "modal" } }),
    (error: unknown) => (error as { code?: string }).code === "slack_api_error",
  );
});

test("rejects invalid modal inputs before making a provider request", async () => {
  let requests = 0;
  const client = createSlackModalClient({
    botToken: "xoxb-test",
    fetchImpl: async () => { requests += 1; return new Response(JSON.stringify({ ok: true, view: { id: "V1" } })); },
  });

  await assert.rejects(client.open({ triggerId: "", view: { type: "modal" } }));
  await assert.rejects(client.open({ triggerId: "1337.1", view: null }));
  assert.equal(requests, 0);
});
