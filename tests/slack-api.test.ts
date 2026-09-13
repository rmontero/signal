import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackApiClient, createSlackThreadClient, SlackApiError } from "../src/adapters/slack-api";
import type { ApprovalNoticeModal } from "../src/services/approve";

const destination = { channelId: "C1", messageTs: "1.2", text: "Synthetic result" };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const updateSuccess = () => json({ ok: true, channel: "C1", ts: "1.2", text: "synthetic-private-source" });
const post = { channelId: "C1", threadTs: "1.2", text: "Synthetic proposal", blocks: [] };
const modal = { triggerId: "1.2", modal: { type: "modal" as const, callback_id: "signal.approve_proposal" as const, private_metadata: "{}", title: { type: "plain_text" as const, text: "Review" }, submit: { type: "plain_text" as const, text: "Approve" }, close: { type: "plain_text" as const, text: "Cancel" }, blocks: [] } };
const safeError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof SlackApiError);
  assert.equal(error.code, code);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)} ${error.stack}`, /synthetic-private-source|synthetic-token/);
  assert.equal(error.cause, undefined);
  return true;
};

test("Slack update verifies the returned destination without exposing response data", async () => {
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => json({ ok: true, channel: "C2", ts: "1.2", text: "synthetic-private-source" }) });
  await assert.rejects(client.updateMessage(destination), (error: unknown) => {
    assert.ok(error instanceof SlackApiError);
    assert.doesNotMatch(String(error), /synthetic-private-source/);
    return true;
  });
});

test("Slack unknown provider errors cannot disclose arbitrary source through providerCode", async () => {
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => json({ ok: false, error: "synthetic-private-source", response_metadata: { messages: ["synthetic-private-source"] } }) });
  await assert.rejects(client.updateMessage(destination), (error: unknown) => {
    assert.ok(error instanceof SlackApiError);
    assert.equal(error.providerCode, undefined);
    assert.doesNotMatch(JSON.stringify(error), /synthetic-private-source/);
    return true;
  });
});

test("Slack channel names, DMs and markup cannot select a notification destination", async () => {
  let calls = 0;
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return json({ ok: true }); } });
  for (const channelId of ["#general", "D1", "U1", "C1|@everyone", "C1\n", "https://example.test"]) {
    await assert.rejects(client.updateMessage({ ...destination, channelId }), SlackApiError);
  }
  assert.equal(calls, 0);
});

test("Slack successful writes retain signatures and target only Slack endpoints", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createSlackApiClient({ botToken: "synthetic-token", apiBaseUrl: "https://slack.test/api", fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    const method = new URL(String(url)).pathname;
    if (method.endsWith("views.open")) return json({ ok: true, view: { id: "V1", private_metadata: "synthetic-private-source" } });
    if (method.endsWith("chat.postMessage")) return json({ ok: true, channel: "C1", ts: "2.2", message: { ts: "2.2", thread_ts: "1.2", text: "synthetic-private-source" } });
    return updateSuccess();
  } });
  assert.equal(await client.updateMessage(destination), undefined);
  assert.deepEqual(await client.openModal(modal), { viewId: "V1" });
  assert.deepEqual(await client.postMessage(post), { messageTs: "2.2" });
  assert.equal(calls.length, 3);
  for (const { url, init } of calls) {
    assert.equal(new URL(url).origin, "https://slack.test");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-token");
    assert.doesNotMatch(String(init.body), /synthetic-token/);
  }
  const body = JSON.parse(String(calls[2].init?.body));
  assert.equal(body.unfurl_links, false);
  assert.equal(body.unfurl_media, false);
  assert.equal(body.client_msg_id, undefined);
});

test("Slack authentication/scope failures do not retry and keep only allowlisted codes", async () => {
  for (const code of ["not_authed", "invalid_auth", "token_revoked", "account_inactive", "missing_scope", "no_permission"]) {
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return json({ ok: false, error: code, needed: "synthetic-private-source" }); } });
    await assert.rejects(client.updateMessage(destination), (error: unknown) => { safeError("slack_auth_error")(error); assert.equal((error as SlackApiError).providerCode, code); return true; });
    assert.equal(calls, 1);
  }
  for (const status of [401, 403]) {
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return new Response("synthetic-private-source", { status }); } });
    await assert.rejects(client.updateMessage(destination), safeError("slack_auth_error"));
    assert.equal(calls, 1);
  }
});

test("Slack retry waits respect Retry-After and preserve the exact update bytes", async () => {
  const bodies: string[] = [];
  const started = performance.now();
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? new Response("synthetic-private-source", { status: 429, headers: { "retry-after": "0.02" } }) : updateSuccess();
  } });
  await client.updateMessage(destination);
  assert.ok(performance.now() - started >= 18);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("Slack rate limits stop at three attempts without exposing error bodies", async () => {
  let calls = 0;
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return json({ error: "synthetic-private-source" }, 429, { "retry-after": "0" }); } });
  await assert.rejects(client.updateMessage(destination), safeError("slack_rate_limited"));
  assert.equal(calls, 3);
});

test("Slack invalid, overflowing or over-budget Retry-After never becomes an early retry", async () => {
  for (const header of [undefined, "-1", "NaN", "Infinity", "1e9", "9".repeat(40), "600000", "0.1"]) {
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", timeoutMs: 50, maxRetryWaitMs: 10, fetchImpl: async () => { calls += 1; return json({}, 429, header === undefined ? {} : { "retry-after": header }); } });
    await assert.rejects(client.updateMessage(destination), safeError("slack_rate_limited"));
    assert.equal(calls, 1);
  }
});

test("Slack retry wait aborts promptly and does not dispatch a second update", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createSlackApiClient({ botToken: "synthetic-token", signal: controller.signal, fetchImpl: async () => {
    calls += 1;
    setTimeout(() => controller.abort(new Error("synthetic-private-source")), 10);
    return json({}, 429, { "retry-after": "1" });
  } });
  await assert.rejects(client.updateMessage(destination), safeError("slack_aborted"));
  assert.equal(calls, 1);
});

test("Slack update retries transport and 5xx failures, then stops at the configured attempt count", async () => {
  for (const response of [() => { throw new Error("synthetic-private-source"); }, () => json({}, 503, { "retry-after": "0" }), () => json({ ok: false, error: "internal_error" }, 200, { "retry-after": "0" })]) {
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", maxAttempts: 2, fetchImpl: async () => { calls += 1; return calls === 1 ? response() : updateSuccess(); } });
    await client.updateMessage(destination);
    assert.equal(calls, 2);
  }
  let calls = 0;
  const client = createSlackApiClient({ botToken: "synthetic-token", maxAttempts: 2, fetchImpl: async () => { calls += 1; return json({}, 502, { "retry-after": "0" }); } });
  await assert.rejects(client.updateMessage(destination), safeError("slack_http_error"));
  assert.equal(calls, 2);
});

test("Slack malformed success responses fail closed and do not retry", async () => {
  for (const body of [null, [], {}, { ok: "true" }, { ok: true }, { ok: true, channel: "C1", ts: "2.2" }]) {
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return json(body); } });
    await assert.rejects(client.updateMessage(destination), safeError("slack_invalid_response"));
    assert.equal(calls, 1);
  }
  for (const body of ["synthetic-private-source", JSON.stringify({ ok: true, extra: "a".repeat(1_048_577) })]) {
    const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => new Response(body) });
    await assert.rejects(client.updateMessage(destination), safeError("slack_invalid_response"));
  }
});

test("Slack deadline aborts a stalled fetch, even when the fetch ignores cancellation", async () => {
  let signal: AbortSignal | null | undefined;
  const client = createSlackApiClient({ botToken: "synthetic-token", timeoutMs: 15, fetchImpl: async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); } });
  await assert.rejects(client.updateMessage(destination), safeError("slack_deadline_exceeded"));
  assert.equal(signal?.aborted, true);
});

test("Slack deadline includes streaming response bodies and cancels the reader", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); }, cancel() { canceled = true; } });
  const client = createSlackApiClient({ botToken: "synthetic-token", timeoutMs: 15, fetchImpl: async () => new Response(stream) });
  await assert.rejects(client.updateMessage(destination), safeError("slack_deadline_exceeded"));
  assert.equal(canceled, true);
});

test("Slack pre-aborted requests perform no transport and redact the abort reason", async () => {
  const controller = new AbortController(); controller.abort(new Error("synthetic-private-source"));
  let calls = 0;
  const options = { botToken: "synthetic-token", signal: controller.signal, fetchImpl: async () => { calls += 1; return updateSuccess(); } };
  const client = createSlackApiClient(options);
  await assert.rejects(client.updateMessage(destination), safeError("slack_aborted"));
  await assert.rejects(client.postMessage(post), safeError("slack_aborted"));
  await assert.rejects(createSlackThreadClient(options).fetchThread(post), safeError("slack_aborted"));
  assert.equal(calls, 0);
});

test("Slack ambiguous proposal posts have exactly one local attempt and a safe uncertainty code", async () => {
  for (const response of [() => { throw new Error("synthetic-private-source"); }, () => json({}, 500), () => json({ ok: false, error: "internal_error" }), () => json({ ok: false, error: "fatal_error" }), () => new Response("synthetic-private-source"), () => json({ ok: true, channel: "C2", ts: "2.2", message: { ts: "2.2", thread_ts: "1.2" } }), () => json({ ok: true, channel: "C1", ts: "2.2", message: { ts: "2.2", thread_ts: "1.3" } }), () => json({ ok: false, error: "synthetic-private-source" })]) {
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return response(); } });
    await assert.rejects(client.postMessage(post), safeError("slack_post_ambiguous"));
    assert.equal(calls, 1);
  }
});

test("Slack proposal post timeout or mid-flight abort stays ambiguous and cannot retry", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", timeoutMs: 15, signal: controller.signal, fetchImpl: async () => {
      calls += 1;
      if (abort) controller.abort(new Error("synthetic-private-source"));
      return new Promise<Response>(() => {});
    } });
    await assert.rejects(client.postMessage(post), safeError("slack_post_ambiguous"));
    assert.equal(calls, 1);
  }
});

test("Slack post rate limits and authentication failures are surfaced without local retries", async () => {
  for (const status of [429, 401]) {
    let calls = 0;
    const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return json({}, status, { "retry-after": "0" }); } });
    await assert.rejects(client.postMessage(post), safeError(status === 429 ? "slack_rate_limited" : "slack_auth_error"));
    assert.equal(calls, 1);
  }
});

test("Slack modal calls never retry and validate returned view identity", async () => {
  for (const body of [{ ok: true }, { ok: true, view: { id: "synthetic-private-source" } }]) {
    const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => json(body) });
    await assert.rejects(client.openModal(modal), safeError("slack_invalid_response"));
  }
  let calls = 0;
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async () => { calls += 1; return json({}, 503); } });
  await assert.rejects(client.openModal(modal), safeError("slack_http_error"));
  assert.equal(calls, 1);
});

test("Slack informational denial notices open unchanged without approval controls or authority", async () => {
  const notice: ApprovalNoticeModal = { type: "modal", title: { type: "plain_text", text: "Proposal unavailable" }, close: { type: "plain_text", text: "Close" }, blocks: [{ type: "section", text: { type: "mrkdwn", text: "You cannot review this proposal." } }] };
  let sent: Record<string, unknown> | undefined;
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/api/views.open");
    sent = JSON.parse(String(init?.body));
    return json({ ok: true, view: { id: "V2" } });
  } });
  assert.deepEqual(await client.openModal({ triggerId: "1.2", modal: notice }), { viewId: "V2" });
  assert.deepEqual(sent, { trigger_id: "1.2", view: notice });
  assert.equal(Object.hasOwn(sent!.view as object, "callback_id"), false);
  assert.equal(Object.hasOwn(sent!.view as object, "private_metadata"), false);
  assert.equal(Object.hasOwn(sent!.view as object, "submit"), false);
});

test("Slack modal default deadline remains below the three-second interaction budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined;
  const client = createSlackApiClient({ botToken: "synthetic-token", fetchImpl: async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); } });
  const check = assert.rejects(client.openModal(modal), safeError("slack_deadline_exceeded"));
  t.mock.timers.tick(2_500);
  await check;
  assert.equal(signal?.aborted, true);
});

test("Slack rejects invalid transport limits and URLs before making a request", () => {
  for (const override of [{ timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 30_001 }, { maxAttempts: 4 }, { maxAttempts: 0 }, { maxRetryWaitMs: Infinity }, { maxRetryWaitMs: -1 }, { apiBaseUrl: "http://slack.test/api" }, { apiBaseUrl: "https://synthetic-token@slack.test/api" }, { apiBaseUrl: "https://slack.test/api?token=synthetic-token" }, { apiBaseUrl: "synthetic-private-source" }]) {
    assert.throws(() => createSlackApiClient({ botToken: "synthetic-token", ...override }), safeError("slack_invalid_input"));
  }
});

const channel = { id: "C1", is_shared: false, is_ext_shared: false, is_im: false, is_mpim: false, is_archived: false, is_member: true };
const root = { ts: "1.2", user: "U1", text: "Synthetic root" };
const reply = { ts: "2.2", thread_ts: "1.2", user: "U2", text: "Synthetic reply" };
const terminal = (messages: unknown[]) => ({ ok: true, messages, has_more: false, response_metadata: { next_cursor: "" } });
function readerFixture(overrides: { channel?: unknown; pages?: unknown[]; permalink?: string } = {}) {
  const requests: URL[] = [];
  let pageIndex = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
    if (url.pathname.endsWith("conversations.info")) return json({ ok: true, channel: overrides.channel ?? channel });
    if (url.pathname.endsWith("conversations.replies")) return json((overrides.pages ?? [terminal([root])])[pageIndex++]);
    assert.ok(url.pathname.endsWith("chat.getPermalink"));
    return json({ ok: true, permalink: overrides.permalink ?? `https://synthetic.slack.com/archives/C1/p${url.searchParams.get("message_ts")?.replace(".", "")}` });
  };
  return { requests, fetchImpl, client: createSlackThreadClient({ botToken: "synthetic-token", fetchImpl }) };
}

test("Slack complete-thread read follows all cursors, excludes bots and obtains validated source permalinks", async () => {
  const bot = { ts: "3.2", thread_ts: "1.2", bot_id: "B1", text: "Synthetic bot" };
  const fixture = readerFixture({ pages: [{ ok: true, messages: [{ ...root, permalink: "https://evil.test", arbitrary: "synthetic-private-source" }], has_more: true, response_metadata: { next_cursor: "cursor+/=" } }, terminal([reply, bot])] });
  const complete = await fixture.client.fetchThread(post);
  assert.equal(complete.pageCount, 2);
  assert.equal(complete.messages.length, 3);
  assert.equal(complete.sourceMessages.length, 2);
  assert.deepEqual(complete.sourceMessages.map((message) => message.permalink), ["https://synthetic.slack.com/archives/C1/p12", "https://synthetic.slack.com/archives/C1/p22"]);
  assert.equal(complete.messages[0].arbitrary, undefined);
  assert.equal(fixture.requests[2].searchParams.get("cursor"), "cursor+/=");
  assert.equal(fixture.requests.length, 5);
});

test("Slack shared, unknown, inaccessible or mismatched channel metadata withholds all thread reads", async () => {
  for (const bad of [{ ...channel, id: "C2" }, { ...channel, is_shared: true }, { ...channel, is_shared: "false" }, { ...channel, is_ext_shared: true }, { ...channel, is_im: true }, { ...channel, is_mpim: true }, { ...channel, is_member: false }, { ...channel, is_archived: true }, { ...channel, is_org_shared: true }, { ...channel, is_pending_ext_shared: true }, { ...channel, pending_shared: ["T2"] }, { id: "C1" }, []]) {
    const fixture = readerFixture({ channel: bad });
    await assert.rejects(fixture.client.fetchThread(post), safeError("slack_channel_unavailable"));
    assert.equal(fixture.requests.length, 1);
  }
});

test("Slack complete-thread rejects missing pages, roots, cursors, malformed rows and conflicting duplicate messages", async () => {
  const cases = [
    [terminal([])], [terminal([reply])], [terminal([null])], [terminal([{ ...root, ts: "not-a-timestamp" }])],
    [terminal([{ ...reply, thread_ts: "9.9" }])], [terminal([{ ...root, channel: "C2" }])], [terminal([{ ...root, user: "U1|@everyone" }])],
    [terminal([{ ...root, text: {} }])], [terminal([{ ...root, edited: { ts: "synthetic-private-source" } }])],
    [{ ok: true, messages: [root], has_more: true }], [{ ok: true, messages: [root] }],
    [{ ok: true, messages: [root], has_more: "false" }], [{ ok: true, messages: [root], has_more: false, response_metadata: [] }],
    [{ ok: true, messages: [root], has_more: true, response_metadata: { next_cursor: 7 } }],
    [{ ok: true, messages: [root], has_more: true, response_metadata: { next_cursor: "a" } }, terminal([{ ...root, text: "Changed" }])],
    [{ ok: true, messages: [root], has_more: true, response_metadata: { next_cursor: "a" } }, { ok: true, messages: [reply], has_more: true, response_metadata: { next_cursor: "a" } }],
    [{ ok: true, messages: [root], has_more: true, response_metadata: { next_cursor: "a" } }, { ok: true, messages: [root], has_more: true, response_metadata: { next_cursor: "b" } }],
  ];
  for (const pages of cases) {
    const fixture = readerFixture({ pages });
    await assert.rejects(fixture.client.fetchThread(post), safeError("incomplete_thread"));
    assert.equal(fixture.requests.some((url) => url.pathname.endsWith("chat.getPermalink")), false);
  }
});

test("Slack thread overflow counts all messages including bots and withholds source output", async () => {
  const fixture = readerFixture({ pages: [terminal([root, { ...reply, bot_id: "B1" }])] });
  await assert.rejects(fixture.client.fetchThread({ ...post, maxMessages: 1 }), safeError("thread_overflow"));
  assert.equal(fixture.requests.length, 2);
});

test("Slack root reply count detects omitted replies and overflow before producing a snapshot", async () => {
  for (const [reply_count, code] of [[1, "incomplete_thread"], ["1", "incomplete_thread"], [-1, "incomplete_thread"], [50, "thread_overflow"]] as const) {
    const fixture = readerFixture({ pages: [terminal([{ ...root, reply_count }])] });
    await assert.rejects(fixture.client.fetchThread(post), safeError(code));
    assert.equal(fixture.requests.length, 2);
  }
  const fixture = readerFixture({ pages: [terminal([{ ...root, reply_count: 1 }, reply])] });
  assert.equal((await fixture.client.fetchThread(post)).messages.length, 2);
});

test("Slack explicit terminal cursors can establish completeness when has_more is absent", async () => {
  const fixture = readerFixture({ pages: [{ ok: true, messages: [root], response_metadata: { next_cursor: "" } }] });
  assert.equal((await fixture.client.fetchThread(post)).sourceMessages.length, 1);
});

test("Slack a cursor is followed even if has_more is false", async () => {
  const fixture = readerFixture({ pages: [{ ok: true, messages: [root], has_more: false, response_metadata: { next_cursor: "next" } }, terminal([reply])] });
  assert.equal((await fixture.client.fetchThread(post)).pageCount, 2);
});

test("Slack unsafe source permalinks reject wrong hosts, channels, messages and markup", async () => {
  for (const permalink of ["javascript:alert(1)", "http://synthetic.slack.com/archives/C1/p12", "https://slack.com.evil.test/archives/C1/p12", "https://evil.test/archives/C1/p12", "https://synthetic-token@synthetic.slack.com/archives/C1/p12", "https://synthetic.slack.com/archives/C2/p12", "https://synthetic.slack.com/archives/C1/p99", "https://synthetic.slack.com/archives/C1/p12|@everyone", "https://synthetic.slack.com/archives/C1/p12#synthetic-private-source", "https://synthetic.slack.com/archives/C1/p12?cid=C2", "https://synthetic.slack.com/archives/C1/p12?thread_ts=9.9", "https://synthetic.slack.com/archives/C1/p12?token=synthetic-token", "https://synthetic.slack.com/archives/C1/p12?cid=C1&cid=C1"]) {
    const fixture = readerFixture({ permalink });
    await assert.rejects(fixture.client.fetchThread(post), safeError("slack_invalid_response"));
  }
});

test("Slack permalink query coordinates are accepted only when they match the retrieved thread", async () => {
  const fixture = readerFixture({ permalink: "https://synthetic.slack.com/archives/C1/p12?thread_ts=1.2&cid=C1" });
  const complete = await fixture.client.fetchThread(post);
  assert.equal(complete.sourceMessages[0].permalink, "https://synthetic.slack.com/archives/C1/p12?thread_ts=1.2&cid=C1");
});

test("Slack thread deadline covers later pages and permalink lookup with no partial result", async () => {
  for (const stalledMethod of ["conversations.replies", "chat.getPermalink"]) {
    const fixture = readerFixture();
    let signal: AbortSignal | null | undefined;
    const client = createSlackThreadClient({ botToken: "synthetic-token", timeoutMs: 15, fetchImpl: async (url, init) => {
      if (String(url).includes(stalledMethod)) { signal = init?.signal; return new Promise<Response>(() => {}); }
      return fixture.fetchImpl(url, init);
    } });
    await assert.rejects(client.fetchThread(post), safeError("slack_deadline_exceeded"));
    assert.equal(signal?.aborted, true);
  }
});

test("Slack bounded thread reads retry rate limits internally and keep the same page coordinates", async () => {
  const fixture = readerFixture();
  let calls = 0;
  const client = createSlackThreadClient({ botToken: "synthetic-token", fetchImpl: async (url, init) => {
    if (String(url).includes("conversations.replies") && ++calls === 1) return json({}, 429, { "retry-after": "0" });
    return fixture.fetchImpl(url, init);
  } });
  assert.equal((await client.fetchThread(post)).pageCount, 1);
  assert.equal(calls, 2);
});

test("Slack a timed-out request cannot resume retries when its ignored-abort fetch eventually returns", async () => {
  let finish: (response: Response) => void = () => {};
  let calls = 0;
  let canceled = false;
  const client = createSlackApiClient({ botToken: "synthetic-token", timeoutMs: 15, fetchImpl: async () => { calls += 1; return new Promise<Response>((resolve) => { finish = resolve; }); } });
  await assert.rejects(client.updateMessage(destination), safeError("slack_deadline_exceeded"));
  finish(new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 429, headers: { "retry-after": "0" } }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(canceled, true);
});

test("Slack thread read authentication and prolonged rate limits cannot produce partial output", async () => {
  for (const status of [401, 429]) {
    const fixture = readerFixture();
    let calls = 0;
    const client = createSlackThreadClient({ botToken: "synthetic-token", fetchImpl: async (url, init) => {
      if (String(url).includes("conversations.replies")) { calls += 1; return new Response("synthetic-private-source", { status, headers: { "retry-after": "600" } }); }
      return fixture.fetchImpl(url, init);
    } });
    await assert.rejects(client.fetchThread(post), safeError(status === 401 ? "slack_auth_error" : "slack_rate_limited"));
    assert.equal(calls, 1);
    assert.equal(fixture.requests.length, 1);
  }
});
