import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitHubReadClient, GitHubReadError } from "../src/adapters/github-read";

function jsonResponse(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("scopes search to the configured repository and caps two queries and five candidates", async () => {
  const requests: string[] = [];
  const client = createGitHubReadClient({
    token: "ghs-read-token",
    apiBaseUrl: "https://github.test/api/v3",
    fetchImpl: async (input) => {
      requests.push(String(input));
      const ids = requests.length === 1 ? [1, 2, 3] : [3, 4, 5, 6];
      return jsonResponse({
        items: ids.map((id) => ({
          id,
          number: id,
          title: `Candidate ${id}`,
          html_url: `https://github.com/acme/signal/issues/${id}`,
          state: "open",
          user: { login: "owner" },
        })),
      });
    },
  });

  const candidates = await client.search({
    owner: "acme",
    repo: "signal",
    queries: ["release plan", "incident"] ,
  });

  assert.equal(candidates.length, 5);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!, /search\/issues\?/);
  assert.match(requests[0]!, /q=release\+plan\+repo%3Aacme%2Fsignal/);
  assert.match(requests[1]!, /q=incident\+repo%3Aacme%2Fsignal/);
});

test("reads an issue target and marks pull requests as non-commentable", async () => {
  const client = createGitHubReadClient({
    token: "ghs-read-token",
    fetchImpl: async (input) => {
      assert.match(String(input), /repos\/acme\/signal\/issues\/42$/);
      return jsonResponse({
        id: 4200,
        number: 42,
        title: "A pull request",
        html_url: "https://github.com/acme/signal/pull/42",
        state: "open",
        pull_request: { url: "https://api.github.com/repos/acme/signal/pulls/42" },
      });
    },
  });

  const target = await client.getIssue({ owner: "acme", repo: "signal", issueNumber: 42 });
  assert.deepEqual(target, {
    id: "4200",
    number: 42,
    title: "A pull request",
    htmlUrl: "https://github.com/acme/signal/pull/42",
    state: "open",
    isPullRequest: true,
    authorLogin: null,
  });
});

test("retries bounded read rate limits and fails without leaking the token", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const client = createGitHubReadClient({
    token: "ghs-secret-read-token",
    wait: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      attempts += 1;
      return new Response("unavailable", { status: 503, headers: { "retry-after": "1" } });
    },
  });

  await assert.rejects(
    client.getIssue({ owner: "acme", repo: "signal", issueNumber: 42 }),
    (error: unknown) => {
      const value = error as { code?: string; message?: string };
      return value.code === "github_read_unavailable" && !value.message?.includes("ghs-secret-read-token");
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 1000]);
});

test("rejects malformed provider identities and does not follow redirects", async () => {
  let requestInit: RequestInit | undefined;
  const client = createGitHubReadClient({
    token: "ghs-read-token",
    fetchImpl: async (_input, init) => {
      requestInit = init;
      return jsonResponse({ items: [{ id: 1, number: 1, title: "bad", html_url: "javascript:alert(1)", state: "open" }] });
    },
  });

  await assert.rejects(
    client.search({ owner: "acme", repo: "signal", queries: ["one"] }),
    (error: unknown) => (error as GitHubReadError).code === "github_read_invalid",
  );
  assert.equal(requestInit?.redirect, "error");
});
