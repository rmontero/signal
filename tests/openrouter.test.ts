import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenRouterClient, OpenRouterError } from "../src/adapters/openrouter";

function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("sends strict JSON schema requests without exposing the API key", async () => {
  let request: Request | undefined;
  const client = createOpenRouterClient({
    apiKey: "secret-key",
    model: "openai/gpt-5-mini",
    model: "openai/gpt-5-mini",
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return response(200, { choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });

  const result = await client.complete({
    system: "system",
    user: "user",
    schemaName: "test_output",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  });

  assert.deepEqual(result, { ok: true });
  assert.ok(request);
  assert.equal(request!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request!.headers.get("authorization"), "Bearer secret-key");
  const payload = await request!.json() as Record<string, unknown>;
  assert.equal(payload.model, "openai/gpt-5-mini");
  assert.equal(payload.max_tokens, 2_000);
  assert.deepEqual(payload.response_format, {
    type: "json_schema",
    json_schema: {
      name: "test_output",
      strict: true,
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    },
  });
  assert.equal(JSON.stringify(payload).includes("secret-key"), false);
});

test("rejects oversized input before making a request", async () => {
  let calls = 0;
  const client = createOpenRouterClient({
    apiKey: "secret-key",
    model: "openai/gpt-5-mini",
    fetchImpl: async () => {
      calls += 1;
      return response(200, {});
    },
    maxInputChars: 10,
  });

  await assert.rejects(
    client.complete({ system: "123456", user: "12345", schemaName: "test", schema: {} }),
    (error: unknown) => error instanceof OpenRouterError && error.code === "openrouter_input_too_large",
  );
  assert.equal(calls, 0);
});

test("maps rate limiting and timeout without returning provider details", async () => {
  const rateLimited = createOpenRouterClient({
    apiKey: "secret-key",
    model: "openai/gpt-5-mini",
    fetchImpl: async () => response(429, { error: { message: "secret provider detail" } }),
  });
  await assert.rejects(
    rateLimited.complete({ system: "s", user: "u", schemaName: "test", schema: {} }),
    (error: unknown) => error instanceof OpenRouterError && error.code === "openrouter_rate_limited" && !error.message.includes("secret provider"),
  );

  const timedOut = createOpenRouterClient({
    apiKey: "secret-key",
    model: "openai/gpt-5-mini",
    timeoutMs: 5,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
    }),
  });
  await assert.rejects(
    timedOut.complete({ system: "s", user: "u", schemaName: "test", schema: {} }),
    (error: unknown) => error instanceof OpenRouterError && error.code === "openrouter_timeout",
  );
});

test("rejects malformed structured output", async () => {
  const client = createOpenRouterClient({
    apiKey: "secret-key",
    model: "openai/gpt-5-mini",
    fetchImpl: async () => response(200, { choices: [{ message: { content: "not-json" } }] }),
  });

  await assert.rejects(
    client.complete({ system: "s", user: "u", schemaName: "test", schema: {} }),
    (error: unknown) => error instanceof OpenRouterError && error.code === "openrouter_invalid_output",
  );
});
