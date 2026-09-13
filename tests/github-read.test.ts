import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitHubReadClient, GitHubReadError, type GitHubReadClientOptions } from "../src/adapters/github-read";

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

test("paginates bounded issue and comment reads for uncertain-write reconciliation", async () => {
  const requests: string[] = [];
  const client = createGitHubReadClient({
    token: "ghs-read-token",
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/comments")) return jsonResponse([{ id: 77, body: "marker", html_url: "https://github.com/acme/signal/issues/42#issuecomment-77", user: { login: "signal-app[bot]" } }]);
      if (url.endsWith("/issues/42")) return jsonResponse({ id: 4200, number: 42, title: "Issue", body: "marker", html_url: "https://github.com/acme/signal/issues/42", state: "open" });
      return jsonResponse([{ id: 42, number: 42, title: "Issue", body: "marker", html_url: "https://github.com/acme/signal/issues/42", state: "open", user: { login: "signal-app[bot]" } }]);
    },
  });
  assert.deepEqual(await client.listIssues?.({ owner: "acme", repo: "signal" }), [{ id: "42", title: "Issue", body: "marker", url: "https://github.com/acme/signal/issues/42", issueNumber: 42, authorLogin: "signal-app[bot]" }]);
  assert.deepEqual(await client.listComments?.({ owner: "acme", repo: "signal", issueNumber: 42 }), [{ id: "77", url: "https://github.com/acme/signal/issues/42#issuecomment-77", body: "marker", authorLogin: "signal-app[bot]", issueId: "4200", issueNumber: 42 }]);
  assert.equal(requests.length, 3);
});

test("repository read returns a validated stable identity and rejects renamed coordinates", async () => {
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse({ id: 123, name: "signal", owner: { login: "acme" } }) });
  assert.deepEqual(await client.getRepository?.({ owner: "acme", repo: "signal" }), { id: "123", owner: "acme", repo: "signal" });
  const changed = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse({ id: 123, name: "renamed", owner: { login: "acme" } }) });
  await assert.rejects(changed.getRepository!({ owner: "acme", repo: "signal" }), GitHubReadError);
});

test("comment read rejects a different parent URL or comment anchor", async () => {
  for (const url of ["https://github.com/acme/signal/issues/43#issuecomment-77", "https://github.com/acme/signal/issues/42#issuecomment-78"]) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async (input) => String(input).includes("/comments")
      ? jsonResponse([{ id: 77, body: "marker", html_url: url, user: { login: "signal-app[bot]" } }])
      : jsonResponse({ id: 4200, number: 42, title: "Issue", html_url: "https://github.com/acme/signal/issues/42", state: "open" }),
    });
    await assert.rejects(client.listComments!({ owner: "acme", repo: "signal", issueNumber: 42 }), GitHubReadError);
  }
});

const coordinates = { owner: "acme", repo: "signal" };
const issueTarget = { ...coordinates, issueNumber: 42 };
const conversationTarget = { ...coordinates, repositoryId: "123", pullRequestNumber: 42, pullRequestId: "8400" };
const api = "https://api.github.com/repos/acme/signal";
const html = "https://github.com/acme/signal";
const date = "2026-09-12T12:00:00Z";

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 4200, number: 42, title: "Issue", body: "Exact body", html_url: `${html}/issues/42`, state: "open", ...overrides };
}

function code(expected: GitHubReadError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof GitHubReadError && error.code === expected;
}

function conversationFixtures(): Record<string, unknown> {
  return {
    [api]: { id: 123, name: "signal", owner: { login: "acme" } },
    [`${api}/pulls/42`]: {
      id: 8400, number: 42, title: "PR title", body: "  PR body\n", html_url: `${html}/pull/42`, state: "open",
      url: `${api}/pulls/42`, issue_url: `${api}/issues/42`,
      base: { repo: { id: 123, name: "signal", owner: { login: "acme" } } },
      user: { login: "author" }, created_at: date, updated_at: date, comments: 1, review_comments: 1,
    },
    [`${api}/pulls/42/reviews`]: [{ id: 80, body: "Review body", state: "CHANGES_REQUESTED", user: { login: "reviewer" }, html_url: `${html}/pull/42#pullrequestreview-80`, pull_request_url: `${api}/pulls/42`, submitted_at: date }],
    [`${api}/pulls/42/comments`]: [{ id: 80, body: "Inline comment", user: { login: "reviewer" }, html_url: `${html}/pull/42#discussion_r80`, pull_request_url: `${api}/pulls/42`, pull_request_review_id: 80, created_at: date, updated_at: date }],
    [`${api}/issues/42/comments`]: [{ id: 80, body: "Issue conversation", user: null, html_url: `${html}/pull/42#issuecomment-80`, issue_url: `${api}/issues/42`, created_at: date, updated_at: date }],
  };
}

function fixtureClient(fixtures: Record<string, unknown>, requests: string[] = [], options: Partial<GitHubReadClientOptions> = {}) {
  return createGitHubReadClient({
    token: "fixture-token", ...options,
    fetchImpl: async (input, init) => {
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      const url = new URL(String(input));
      requests.push(url.toString());
      const payload = fixtures[`${url.origin}${url.pathname}`];
      assert.notEqual(payload, undefined, "Unexpected fixture endpoint");
      return jsonResponse(payload);
    },
  });
}

test("a pre-cancelled read sends no request or wait and never exposes the abort reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private-abort-reason"));
  let calls = 0;
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => { calls++; return jsonResponse(issue()); }, wait: async () => { calls++; } });
  await assert.rejects(client.getIssue({ ...issueTarget, signal: controller.signal }), (error) => code("github_read_unavailable")(error) && !(error as Error).message.includes("private-abort-reason"));
  assert.equal(calls, 0);
});

test("a transport ignoring cancellation still has a finite deadline and no retry", { timeout: 2000 }, async () => {
  let attempts = 0;
  let signal: AbortSignal | undefined;
  const client = createGitHubReadClient({ token: "fixture-token", readTimeoutMs: 20, fetchImpl: async (_input, init) => {
    attempts++;
    signal = init?.signal as AbortSignal;
    return new Promise<Response>(() => {});
  } });
  await assert.rejects(client.getIssue(issueTarget), code("github_read_unavailable"));
  assert.equal(signal?.aborted, true);
  assert.equal(attempts, 1);
});

test("a stalled response body is aborted, cancelled, and not retried", { timeout: 2000 }, async () => {
  let cancelled = false;
  let attempts = 0;
  const client = createGitHubReadClient({ token: "fixture-token", readTimeoutMs: 20, fetchImpl: async () => {
    attempts++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  await assert.rejects(client.getIssue(issueTarget), code("github_read_unavailable"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(attempts, 1);
});

test("cancellation during the actual retry wait never sends a second request", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let attempts = 0;
  let enteredWait!: () => void;
  const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
  let waitSignal: AbortSignal | undefined;
  const client = createGitHubReadClient({
    token: "fixture-token", readTimeoutMs: 2000,
    fetchImpl: async () => { attempts++; return new Response(null, { status: 429, headers: { "retry-after": "1" } }); },
    wait: async (_milliseconds, signal) => { waitSignal = signal; enteredWait(); return new Promise<void>(() => {}); },
  });
  const result = client.getIssue({ ...issueTarget, signal: controller.signal });
  const rejection = assert.rejects(result, code("github_read_unavailable"));
  await waiting;
  controller.abort(new Error("private-reason"));
  await rejection;
  assert.equal(waitSignal?.aborted, true);
  assert.equal(attempts, 1);
});

test("one deadline covers retries and every reconciliation page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  const client = createGitHubReadClient({
    token: "fixture-token", readTimeoutMs: 1000, wait: async () => {},
    fetchImpl: async (input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (signals.length === 1) { t.mock.timers.tick(600); return new Response(null, { status: 503 }); }
      if (signals.length === 2) {
        const next = new URL(String(input)); next.searchParams.set("page", "2");
        return jsonResponse([issue()], 200, { link: `<${next}>; rel="next"` });
      }
      return new Promise<Response>(() => {});
    },
  });
  const result = client.listIssues!(coordinates);
  const rejection = assert.rejects(result, code("github_read_unavailable"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 3);
  t.mock.timers.tick(399);
  assert.equal(signals[0]!.aborted, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.ok(signals.every((signal) => signal === signals[0] && signal.aborted));
});

for (const value of [Infinity, NaN, 0, -1, 60_001, 1.5]) {
  test(`rejects non-finite or out-of-range read budget ${String(value)}`, () => {
    assert.throws(() => createGitHubReadClient({ token: "fixture-token", readTimeoutMs: value }), code("github_read_invalid"));
  });
}

for (const retryAfter of ["999999999999999999999999999999999999999", "6", "-1", "NaN", "Infinity", "invalid", "0x10"]) {
  test(`rejects excessive or malformed Retry-After ${retryAfter} without retrying early`, async () => {
    let requests = 0;
    let waits = 0;
    const client = createGitHubReadClient({ token: "fixture-token", wait: async () => { waits++; }, fetchImpl: async () => {
      requests++; return new Response(null, { status: 429, headers: { "retry-after": retryAfter } });
    } });
    await assert.rejects(client.getIssue(issueTarget), code("github_read_unavailable"));
    assert.equal(requests, 1);
    assert.equal(waits, 0);
  });
}

test("HTTP-date Retry-After and primary rate-limit resets are honored within the cap", async (t) => {
  const now = Date.parse(date);
  t.mock.timers.enable({ apis: ["Date"], now });
  const headerCases: HeadersInit[] = [{ "retry-after": new Date(now + 2000).toUTCString() }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 2) }];
  for (const headers of headerCases) {
    const waits: number[] = [];
    let requests = 0;
    const client = createGitHubReadClient({ token: "fixture-token", wait: async (milliseconds) => { waits.push(milliseconds); }, fetchImpl: async () => {
      requests++; return requests === 1 ? new Response(null, { status: 403, headers }) : jsonResponse(issue());
    } });
    assert.equal((await client.getIssue(issueTarget)).id, "4200");
    assert.deepEqual(waits, [2000]);
    assert.equal(requests, 2);
  }
});

test("rate limits without a bounded delay fail closed and ordinary forbidden responses do not retry", async () => {
  for (const [status, expected] of [[429, "github_read_unavailable"], [403, "github_read_rejected"]] as const) {
    let requests = 0;
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => { requests++; return new Response(null, { status }); } });
    await assert.rejects(client.getIssue(issueTarget), code(expected));
    assert.equal(requests, 1);
  }
});

test("provider waits beyond the remaining total budget fail before waiting", async () => {
  let waits = 0;
  const client = createGitHubReadClient({ token: "fixture-token", readTimeoutMs: 100, wait: async () => { waits++; }, fetchImpl: async () => new Response(null, { status: 503, headers: { "retry-after": "1" } }) });
  await assert.rejects(client.getIssue(issueTarget), code("github_read_unavailable"));
  assert.equal(waits, 0);
});

test("transport and invalid-JSON failures expose only sanitized errors", async () => {
  for (const fetchImpl of [async () => { throw new Error("private-provider-content"); }, async () => new Response("private-provider-content")]) {
    const client = createGitHubReadClient({ token: "private-token", maxReadRetries: 0, fetchImpl });
    await assert.rejects(client.getIssue(issueTarget), (error) => error instanceof GitHubReadError && !JSON.stringify({ message: error.message, cause: error.cause }).includes("private"));
  }
});

test("response byte bounds apply to both declared and streaming lengths", async () => {
  for (const response of [new Response("{}", { headers: { "content-length": "2000001" } }), new Response(" ".repeat(2_000_001))]) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => response });
    await assert.rejects(client.getIssue(issueTarget), code("github_read_unavailable"));
  }
});

test("issue reads reject a different requested number and mismatched numeric URL", async () => {
  for (const payload of [issue({ number: 43, html_url: `${html}/issues/43` }), issue({ html_url: `${html}/issues/43` }), issue({ html_url: `${html}/issues/042` }), issue({ html_url: `${html}/issues/not-a-number` })]) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse(payload) });
    await assert.rejects(client.getIssue(issueTarget), code("github_read_invalid"));
  }
});

test("canonical provider IDs and URLs reject unsafe numbers, credentials, ports, query strings and renamed repositories", async () => {
  const payloads = [
    ...[0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, "04200", "1e3"].map((id) => issue({ id })),
    ...[`${html}/issues/42?extra=true`, `${html}/issues/42#fragment`, "https://x@github.com/acme/signal/issues/42", "https://github.com:8443/acme/signal/issues/42", "https://github.com/acme/renamed/issues/42", "https://github.com/acme/signal/pull/42/"].map((html_url) => issue({ html_url })),
    issue({ repository_url: "https://api.github.com/repos/another/signal" }),
    issue({ url: `${api}/issues/43` }),
    issue({ pull_request: { url: `${api}/pulls/42` } }),
  ];
  for (const payload of payloads) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse(payload) });
    await assert.rejects(client.getIssue(issueTarget), code("github_read_invalid"));
  }
});

test("repository dot segments are rejected before transport", async () => {
  let requests = 0;
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => { requests++; return jsonResponse(issue()); } });
  await assert.rejects(client.getIssue({ ...issueTarget, owner: ".." }), code("github_read_invalid"));
  await assert.rejects(client.getIssue({ ...issueTarget, repo: "." }), code("github_read_invalid"));
  assert.equal(requests, 0);
});

test("search rejects incomplete results and validates every returned candidate even beyond its final selection", async () => {
  for (const payload of [
    { incomplete_results: true, items: [issue()] },
    { incomplete_results: "false", items: [] },
    { items: [issue({ number: 99 })] },
  ]) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse(payload) });
    await assert.rejects(client.search({ ...coordinates, queries: ["bounded"] }), GitHubReadError);
  }
  let requests = 0;
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => {
    requests++;
    return jsonResponse({ items: requests === 1
      ? [1, 2, 3, 4].map((id) => issue({ id, number: id, html_url: `${html}/issues/${id}` }))
      : [issue({ id: 5, number: 5, html_url: `${html}/issues/5` }), issue({ id: 6, number: 6, html_url: "https://github.com/other/private/issues/6" })] });
  } });
  await assert.rejects(client.search({ ...coordinates, queries: ["first", "second"] }), code("github_read_invalid"));
});

test("reconciliation follows short pages with next links and returns actual parent identity", async () => {
  const requests: string[] = [];
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async (input) => {
    const url = new URL(String(input)); requests.push(url.toString());
    if (!url.pathname.endsWith("/comments")) return jsonResponse(issue());
    const page = Number(url.searchParams.get("page"));
    const id = 70 + page;
    const payload = [{ id, body: `Body ${id}`, html_url: `${html}/issues/42#issuecomment-${id}`, issue_url: `${api}/issues/42` }];
    url.searchParams.set("page", "2");
    return jsonResponse(payload, 200, page === 1 ? { link: `<${url}>; rel="next"` } : {});
  } });
  const records = await client.listComments!(issueTarget);
  assert.deepEqual(records.map((entry) => ({ id: entry.id, issueId: entry.issueId, issueNumber: entry.issueNumber })), [{ id: "71", issueId: "4200", issueNumber: 42 }, { id: "72", issueId: "4200", issueNumber: 42 }]);
  assert.equal(requests.length, 3);
});

test("reconciliation never treats a PR as an issue and retains exact title/body bytes", async () => {
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse([
    issue({ title: "  Exact title  ", body: "  Exact\r\nbody  " }),
    issue({ id: 4300, number: 43, html_url: `${html}/pull/43`, pull_request: { url: `${api}/pulls/43` } }),
  ]) });
  const records = await client.listIssues!(coordinates);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.title, "  Exact title  ");
  assert.equal(records[0]!.body, "  Exact\r\nbody  ");
});

test("reconciliation assignees distinguish omitted, empty, and actual provider lists", async () => {
  for (const [extra, expected] of [
    [{}, undefined],
    [{ assignees: [] }, []],
    [{ assignees: [{ login: "owner" }, { login: "signal-app[bot]" }] }, ["owner", "signal-app[bot]"]],
  ] as const) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse([issue(extra)]) });
    const records = await client.listIssues!(coordinates);
    assert.deepEqual(records[0]!.assignees, expected);
    if (expected === undefined) assert.equal(Object.hasOwn(records[0]!, "assignees"), false);
  }
});

test("reconciliation rejects malformed assignees without inventing empty evidence", async () => {
  for (const assignees of [null, {}, [null], ["owner"], [{}], [{ login: "" }], [{ login: "bad/login" }], [{ login: 123 }], [{ login: "owner" }, { login: "owner" }]]) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => jsonResponse([issue({ assignees })]) });
    await assert.rejects(client.listIssues!(coordinates), code("github_read_invalid"));
  }
});

test("reconciliation rejects wrong parent numbers, PR parents and conflicting comment parent URLs", async () => {
  for (const parent of [issue({ number: 43, html_url: `${html}/issues/43` }), issue({ html_url: `${html}/pull/42` })]) {
    let requests = 0;
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => { requests++; return jsonResponse(parent); } });
    await assert.rejects(client.listComments!(issueTarget), code("github_read_invalid"));
    assert.equal(requests, 1);
  }
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async (input) => jsonResponse(String(input).includes("/comments")
    ? [{ id: 77, body: "marker", html_url: `${html}/issues/42#issuecomment-77`, issue_url: `${api}/issues/43` }] : issue()) });
  await assert.rejects(client.listComments!(issueTarget), code("github_read_invalid"));
});

test("reconciliation rejects missing, repeated, malformed, redirected and exhausted pages", async () => {
  for (const kind of ["missing", "repeated", "invalid", "foreign", "loop", "skip", "truncated", "bound", "oversized", "identity_changed"] as const) {
    let requests = 0;
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async (input) => {
      requests++;
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      const id = kind === "repeated" ? 1 : page;
      const payload = [issue({ id, number: kind === "identity_changed" ? 1 : id, html_url: `${html}/issues/${kind === "identity_changed" ? 1 : id}` })];
      if (kind === "missing" && page === 2) return jsonResponse([]);
      if (kind === "oversized") return jsonResponse(Array.from({ length: 101 }, (_v, i) => issue({ id: i + 1 })));
      if (kind === "invalid") return jsonResponse(payload, 200, { link: "not-a-link" });
      if (kind === "foreign") url.hostname = "foreign.test";
      url.searchParams.set("page", String(kind === "loop" ? page : kind === "skip" ? page + 2 : page + 1));
      const link = `<${url}>; rel="${kind === "truncated" ? "last" : "next"}"`;
      return jsonResponse(payload, 200, { link });
    } });
    await assert.rejects(client.listIssues!(coordinates), GitHubReadError, kind);
    assert.ok(requests <= 10);
  }
});

test("full pages without Link require another page and a later provider error cannot return partial reconciliation", async () => {
  let requests = 0;
  const client = createGitHubReadClient({ token: "fixture-token", maxReadRetries: 0, fetchImpl: async () => {
    requests++;
    return requests === 1 ? jsonResponse(Array.from({ length: 100 }, (_v, i) => issue({ id: i + 1, number: i + 1, html_url: `${html}/issues/${i + 1}` }))) : new Response(null, { status: 503 });
  } });
  await assert.rejects(client.listIssues!(coordinates), code("github_read_unavailable"));
  assert.equal(requests, 2);
});

test("PR conversation returns genuine body, review and both comment kinds with distinct stable evidence IDs", async () => {
  const requests: string[] = [];
  const result = await fixtureClient(conversationFixtures(), requests).getPullRequestConversation!(conversationTarget);
  assert.deepEqual(result.repository, { id: "123", ...coordinates });
  assert.equal(result.pullRequest.id, "8400");
  assert.equal(result.pullRequest.isPullRequest, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.evidence, [
    { id: "pull_request_body:8400", sourceId: "8400", kind: "pull_request_body", permalink: `${html}/pull/42`, body: "  PR body\n", authorLogin: "author", createdAt: date, updatedAt: date },
    { id: "review:80", sourceId: "80", kind: "review", permalink: `${html}/pull/42#pullrequestreview-80`, body: "Review body", authorLogin: "reviewer", createdAt: date, updatedAt: null, reviewState: "CHANGES_REQUESTED" },
    { id: "review_comment:80", sourceId: "80", kind: "review_comment", permalink: `${html}/pull/42#discussion_r80`, body: "Inline comment", authorLogin: "reviewer", createdAt: date, updatedAt: date, reviewId: "80" },
    { id: "issue_comment:80", sourceId: "80", kind: "issue_comment", permalink: `${html}/pull/42#issuecomment-80`, body: "Issue conversation", authorLogin: null, createdAt: date, updatedAt: date },
  ]);
  assert.equal(requests.length, 5);
});

test("PR conversation rejects wrong repository and PR identities before reading conversations", async () => {
  for (const kind of ["repository_id", "repository_name", "pr_id", "pr_number", "pr_url", "pr_issue_url", "base_id", "base_owner", "issue_id_used_as_pr_id"] as const) {
    const fixtures = conversationFixtures();
    const repo = fixtures[api] as Record<string, unknown>;
    const pr = fixtures[`${api}/pulls/42`] as Record<string, unknown>;
    if (kind === "repository_id") repo.id = 124;
    if (kind === "repository_name") repo.name = "renamed";
    if (kind === "pr_id") pr.id = 8401;
    if (kind === "pr_number") { pr.number = 43; pr.html_url = `${html}/pull/43`; }
    if (kind === "pr_url") pr.url = `${api}/pulls/43`;
    if (kind === "pr_issue_url") pr.issue_url = `${api}/issues/43`;
    if (kind === "base_id") pr.base = { repo: { id: 124, name: "signal", owner: { login: "acme" } } };
    if (kind === "base_owner") pr.base = { repo: { id: 123, name: "signal", owner: { login: "other" } } };
    const requests: string[] = [];
    await assert.rejects(fixtureClient(fixtures, requests).getPullRequestConversation!({ ...conversationTarget, pullRequestId: kind === "issue_id_used_as_pr_id" ? "4200" : "8400" }), code("github_read_invalid"), kind);
    assert.ok(requests.length <= 2);
  }
});

test("PR conversation rejects wrong evidence parents, IDs, permalinks, review references, bodies and timestamps", async () => {
  const changes: Array<[string, Record<string, unknown>]> = [
    ["pulls/42/reviews", { pull_request_url: `${api}/pulls/43` }],
    ["pulls/42/reviews", { html_url: `${html}/pull/42#pullrequestreview-81` }],
    ["pulls/42/reviews", { submitted_at: undefined }],
    ["pulls/42/reviews", { state: "MADE_UP" }],
    ["pulls/42/comments", { pull_request_url: `${api}/pulls/43` }],
    ["pulls/42/comments", { html_url: `${html}/pull/43#discussion_r80` }],
    ["pulls/42/comments", { html_url: `${html}/pull/42#discussion_r81` }],
    ["pulls/42/comments", { pull_request_review_id: 999 }],
    ["issues/42/comments", { issue_url: "https://api.github.com/repos/other/repo/issues/42" }],
    ["issues/42/comments", { html_url: `${html}/pull/42#issuecomment-81` }],
    ["issues/42/comments", { id: "080" }],
    ["issues/42/comments", { body: undefined }],
    ["issues/42/comments", { body: null }],
    ["issues/42/comments", { user: { login: "bad/login" } }],
    ["issues/42/comments", { created_at: "yesterday" }],
    ["issues/42/comments", { created_at: "2026-02-30T12:00:00Z" }],
  ];
  for (const [path, override] of changes) {
    const fixtures = conversationFixtures();
    Object.assign((fixtures[`${api}/${path}`] as Record<string, unknown>[])[0]!, override);
    await assert.rejects(fixtureClient(fixtures).getPullRequestConversation!(conversationTarget), GitHubReadError);
  }
});

test("PR conversation preserves explicit empty text and excludes unsubmitted reviews and their comments", async () => {
  const fixtures = conversationFixtures();
  const pr = fixtures[`${api}/pulls/42`] as Record<string, unknown>;
  pr.body = null;
  const review = (fixtures[`${api}/pulls/42/reviews`] as Record<string, unknown>[])[0]!;
  review.state = "PENDING";
  delete review.submitted_at;
  (fixtures[`${api}/issues/42/comments`] as Record<string, unknown>[])[0]!.body = "";
  const result = await fixtureClient(fixtures).getPullRequestConversation!({ ...coordinates, repositoryId: "123", pullRequestNumber: 42 });
  assert.deepEqual(result.evidence.map((entry) => [entry.kind, entry.body]), [["pull_request_body", ""], ["issue_comment", ""]]);
});

test("PR conversation accepts provider-returned legacy discussion permalinks and a null review parent", async () => {
  const fixtures = conversationFixtures();
  const comment = (fixtures[`${api}/pulls/42/comments`] as Record<string, unknown>[])[0]!;
  comment.html_url = `${html}/pull/42#discussion-diff-80`;
  comment.pull_request_review_id = null;
  const result = await fixtureClient(fixtures).getPullRequestConversation!(conversationTarget);
  const evidence = result.evidence.find((entry) => entry.kind === "review_comment")!;
  assert.equal(evidence.permalink, comment.html_url);
  assert.equal(evidence.reviewId, null);
});

test("PR conversation never returns oversized context or inconsistent counts as complete", async () => {
  for (const override of [{ body: "x".repeat(40_001) }, { comments: 2 }, { review_comments: 2 }, { comments: -1 }]) {
    const fixtures = conversationFixtures();
    Object.assign(fixtures[`${api}/pulls/42`] as Record<string, unknown>, override);
    await assert.rejects(fixtureClient(fixtures).getPullRequestConversation!(conversationTarget), code("github_read_unavailable"));
  }
});

test("PR conversation enumerates pages but rejects more than fifty records without truncating", async () => {
  const fixtures = conversationFixtures();
  let reviewPages = 0;
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/reviews")) {
      reviewPages++;
      const page = Number(url.searchParams.get("page"));
      url.searchParams.set("page", String(page + 1));
      const payload = Array.from({ length: 20 }, (_value, i) => {
        const id = page * 100 + i;
        return { id, body: "Review", state: "COMMENTED", submitted_at: date, pull_request_url: `${api}/pulls/42`, html_url: `${html}/pull/42#pullrequestreview-${id}` };
      });
      return jsonResponse(payload, 200, { link: `<${url}>; rel="next"` });
    }
    return jsonResponse(fixtures[`${url.origin}${url.pathname}`]);
  } });
  await assert.rejects(client.getPullRequestConversation!(conversationTarget), code("github_read_unavailable"));
  assert.equal(reviewPages, 3);
});

test("a later PR evidence endpoint failure never returns partial evidence as success", async () => {
  const fixtures = conversationFixtures();
  const client = createGitHubReadClient({ token: "fixture-token", maxReadRetries: 0, fetchImpl: async (input) => {
    const url = new URL(String(input));
    return url.pathname.endsWith("/issues/42/comments") ? new Response(null, { status: 503 }) : jsonResponse(fixtures[`${url.origin}${url.pathname}`]);
  } });
  await assert.rejects(client.getPullRequestConversation!(conversationTarget), code("github_read_unavailable"));
});

test("a stuck retry wait remains within the same total deadline", { timeout: 2000 }, async () => {
  let requests = 0;
  let waits = 0;
  const client = createGitHubReadClient({ token: "fixture-token", readTimeoutMs: 30, fetchImpl: async () => {
    requests++; return new Response(null, { status: 503, headers: { "retry-after": "0.001" } });
  }, wait: async () => { waits++; return new Promise<void>(() => {}); } });
  await assert.rejects(client.getIssue(issueTarget), code("github_read_unavailable"));
  assert.equal(requests, 1);
  assert.equal(waits, 1);
});

test("the default Retry-After timer is cancelled immediately on caller abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let requests = 0;
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => {
    requests++; return new Response(null, { status: 429, headers: { "retry-after": "5" } });
  } });
  const rejection = assert.rejects(client.getIssue({ ...issueTarget, signal: controller.signal }), code("github_read_unavailable"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await rejection;
  t.mock.timers.tick(60_000);
  assert.equal(requests, 1);
});

test("repository, PR and conversation endpoint reads share a single deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixtures = conversationFixtures();
  const signals: AbortSignal[] = [];
  const client = createGitHubReadClient({ token: "fixture-token", readTimeoutMs: 1000, fetchImpl: async (input, init) => {
    signals.push(init?.signal as AbortSignal);
    const url = new URL(String(input));
    if (signals.length === 1) t.mock.timers.tick(600);
    if (url.pathname.endsWith("/reviews")) return new Promise<Response>(() => {});
    return jsonResponse(fixtures[`${url.origin}${url.pathname}`]);
  } });
  const rejection = assert.rejects(client.getPullRequestConversation!(conversationTarget), code("github_read_unavailable"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 3);
  t.mock.timers.tick(400);
  await rejection;
  assert.ok(signals.every((signal) => signal === signals[0] && signal.aborted));
});

test("search queries cannot introduce a competing repository scope", async () => {
  let requests = 0;
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async () => { requests++; return jsonResponse({ items: [] }); } });
  for (const query of ["repo:other/private", "anything OR repo:other/private", "org:other", "user:other", "foo\nrepo:other/private"]) {
    await assert.rejects(client.search({ ...coordinates, queries: [query] }), code("github_read_invalid"));
  }
  assert.equal(requests, 0);
});

test("pagination rejects ambiguous page parameters, incorrect previous links and changed page size", async () => {
  for (const kind of ["duplicate", "previous", "size"] as const) {
    const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async (input) => {
      const url = new URL(String(input));
      url.searchParams.set("page", "2");
      if (kind === "duplicate") url.searchParams.append("page", "99");
      if (kind === "size") url.searchParams.set("per_page", "1");
      return jsonResponse([issue()], 200, { link: `<${url}>; rel="${kind === "previous" ? "prev" : "next"}"` });
    } });
    await assert.rejects(client.listIssues!(coordinates), GitHubReadError);
  }
});

test("a fully enumerated PR review page succeeds without inventing links or losing evidence", async () => {
  const fixtures = conversationFixtures();
  let pages = 0;
  const first = (fixtures[`${api}/pulls/42/reviews`] as Record<string, unknown>[])[0]!;
  const client = createGitHubReadClient({ token: "fixture-token", fetchImpl: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/reviews")) {
      pages++;
      const id = pages === 1 ? 80 : 81;
      const review = { ...first, id, html_url: `${html}/pull/42#pullrequestreview-${id}` };
      url.searchParams.set("page", "2");
      return jsonResponse([review], 200, pages === 1 ? { link: `<${url}>; rel="next"` } : {});
    }
    return jsonResponse(fixtures[`${url.origin}${url.pathname}`]);
  } });
  const result = await client.getPullRequestConversation!(conversationTarget);
  assert.equal(pages, 2);
  assert.deepEqual(result.evidence.filter((entry) => entry.kind === "review").map((entry) => entry.permalink), [`${html}/pull/42#pullrequestreview-80`, `${html}/pull/42#pullrequestreview-81`]);
});

test("rate-limit resets never allow a retry earlier than either server delay", async (t) => {
  const now = Date.parse(date);
  t.mock.timers.enable({ apis: ["Date"], now });
  let requests = 0;
  let waits = 0;
  const client = createGitHubReadClient({ token: "fixture-token", wait: async () => { waits++; }, fetchImpl: async () => {
    requests++;
    return new Response(null, { status: 403, headers: { "retry-after": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 60) } });
  } });
  await assert.rejects(client.getIssue(issueTarget), code("github_read_unavailable"));
  assert.equal(requests, 1);
  assert.equal(waits, 0);
});
