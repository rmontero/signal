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
  assert.deepEqual(payload.provider, { require_parameters: true });
  assert.deepEqual(payload.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
  ]);
  assert.equal(request!.redirect, "error");
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

test("keeps the default combined system and user input boundary before fetch", async () => {
  let calls = 0;
  const client = createOpenRouterClient({
    apiKey: "synthetic-key",
    model: "openai/gpt-5-mini",
    fetchImpl: async () => {
      calls += 1;
      return response(200, { choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });
  const input = { system: "s".repeat(8_000), user: "u".repeat(40_000), schemaName: "test", schema: {} };
  assert.deepEqual(await client.complete(input), { ok: true });
  assert.equal(calls, 1);

  await assert.rejects(
    client.complete({ ...input, system: `${input.system}s` }),
    (error: unknown) => error instanceof OpenRouterError && error.code === "openrouter_input_too_large",
  );
  assert.equal(calls, 1);
});

test("fails closed on provider routing errors without retrying or weakening parameters", async () => {
  for (const status of [400, 404, 503, 200]) {
    let calls = 0;
    let payload: Record<string, unknown> | undefined;
    const client = createOpenRouterClient({
      apiKey: "synthetic-key",
      model: "openai/gpt-5-mini",
      fetchImpl: async (_input, init) => {
        calls += 1;
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // Even an error envelope containing a completion cannot be a success.
        return response(status, {
          error: { message: "synthetic-private-provider-detail" },
          choices: [{ message: { content: '{"ok":true}' } }],
        });
      },
    });
    await assert.rejects(
      client.complete({ system: "s", user: "u", schemaName: "test", schema: {} }),
      (error: unknown) => error instanceof OpenRouterError
        && error.code === (status === 400 || status === 200 ? "openrouter_rejected" : "openrouter_unavailable")
        && error.status === status
        && !error.message.includes("synthetic-private-provider-detail"),
    );
    assert.equal(calls, 1);
    assert.deepEqual(payload?.provider, { require_parameters: true });
    assert.equal(payload?.model, "openai/gpt-5-mini");
    assert.equal(Object.hasOwn(payload!, "models"), false);
  }
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
