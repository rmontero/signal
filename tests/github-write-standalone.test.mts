import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubWriteClient } from "../src/adapters/github-write-standalone.mts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("creates an issue with the exact allowed payload and returns provider identity", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;

  const client = createGitHubWriteClient({
    token: "ghs-test-token",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return jsonResponse({
        id: 101,
        number: 42,
        html_url: "https://github.com/acme/signal/issues/42",
        assignees: [{ login: "cesar" }],
      });
    },
  });

  const result = await client.createIssue({
    owner: "acme",
    repo: "signal",
    title: "Coordinate release",
    body: "Ship the approved release.\n",
    assignees: ["cesar"],
  });

  assert.equal(requestUrl, "https://api.github.com/repos/acme/signal/issues");
  assert.equal(requestInit?.method, "POST");
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer ghs-test-token");
  assert.equal(new Headers(requestInit?.headers).get("accept"), "application/vnd.github+json");
  assert.equal(new Headers(requestInit?.headers).get("x-github-api-version"), "2022-11-28");
  assert.equal(requestInit?.redirect, "error");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    title: "Coordinate release",
    body: "Ship the approved release.\n",
    assignees: ["cesar"],
  });
  assert.deepEqual(result, {
    id: "101",
    number: 42,
    url: "https://github.com/acme/signal/issues/42",
    assignees: ["cesar"],
  });
});

test("adds a progress comment with only the persisted body", async () => {
  let requestUrl = "";
  let requestBody = "";

  const client = createGitHubWriteClient({
    token: "ghs-test-token",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body);
      return jsonResponse({
        id: 303,
        html_url: "https://github.com/acme/signal/issues/42#issuecomment-303",
      });
    },
  });

  const result = await client.addProgressComment({
    owner: "acme",
    repo: "signal",
    issueNumber: 42,
    body: "Progress update with exact bytes.\n",
  });

  assert.equal(requestUrl, "https://api.github.com/repos/acme/signal/issues/42/comments");
  assert.deepEqual(JSON.parse(requestBody), { body: "Progress update with exact bytes.\n" });
  assert.deepEqual(result, {
    id: "303",
    url: "https://github.com/acme/signal/issues/42#issuecomment-303",
  });
});

test("rejects invalid repository or mutation input before making a request", async () => {
  let calls = 0;
  const client = createGitHubWriteClient({
    token: "ghs-test-token",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  await assert.rejects(
    client.createIssue({
      owner: "acme/evil",
      repo: "signal",
      title: "Title",
      body: "Body",
      assignees: [],
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_input",
  );

  await assert.rejects(
    client.createIssue({
      owner: "acme",
      repo: "signal",
      title: "Title",
      body: "Body",
      assignees: ["one", "two"],
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_input",
  );

  await assert.rejects(
    client.addProgressComment({ owner: "acme", repo: "signal", issueNumber: 0, body: "Body" }),
    (error: unknown) => (error as { code?: string }).code === "invalid_input",
  );

  assert.equal(calls, 0);
});

test("classifies a definitive GitHub rejection without retrying or leaking the token", async () => {
  let calls = 0;
  const client = createGitHubWriteClient({
    token: "ghs-secret-token",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ message: "Validation Failed", documentation_url: "https://docs.github.com" }, 422);
    },
  });

  await assert.rejects(
    client.addProgressComment({ owner: "acme", repo: "signal", issueNumber: 42, body: "Body" }),
    (error: unknown) => {
      const candidate = error as { code?: string; outcome?: string; status?: number; message?: string };
      return (
        candidate.code === "github_rejected" &&
        candidate.outcome === "definite_rejection" &&
        candidate.status === 422 &&
        !candidate.message?.includes("ghs-secret-token")
      );
    },
  );

  assert.equal(calls, 1);
});

test("classifies server and network outcomes as unknown without retrying", async () => {
  let serverCalls = 0;
  const serverFailureClient = createGitHubWriteClient({
    token: "ghs-test-token",
    fetchImpl: async () => {
      serverCalls += 1;
      return jsonResponse({ message: "Internal Server Error" }, 500);
    },
  });

  await assert.rejects(
    serverFailureClient.createIssue({
      owner: "acme",
      repo: "signal",
      title: "Title",
      body: "Body",
      assignees: [],
    }),
    (error: unknown) => {
      const candidate = error as { code?: string; outcome?: string; status?: number };
      return candidate.code === "github_unknown" && candidate.outcome === "unknown" && candidate.status === 500;
    },
  );
  assert.equal(serverCalls, 1);

  let networkCalls = 0;
  const networkFailureClient = createGitHubWriteClient({
    token: "ghs-test-token",
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("socket closed");
    },
  });

  await assert.rejects(
    networkFailureClient.addProgressComment({ owner: "acme", repo: "signal", issueNumber: 42, body: "Body" }),
    (error: unknown) => {
      const candidate = error as { code?: string; outcome?: string };
      return candidate.code === "github_unknown" && candidate.outcome === "unknown";
    },
  );
  assert.equal(networkCalls, 1);
});

test("treats a malformed successful response as unknown", async () => {
  const client = createGitHubWriteClient({
    token: "ghs-test-token",
    fetchImpl: async () => jsonResponse({ ok: true }),
  });

  await assert.rejects(
    client.createIssue({
      owner: "acme",
      repo: "signal",
      title: "Title",
      body: "Body",
      assignees: [],
    }),
    (error: unknown) => {
      const candidate = error as { code?: string; outcome?: string };
      return candidate.code === "github_unknown" && candidate.outcome === "unknown";
    },
  );
});
