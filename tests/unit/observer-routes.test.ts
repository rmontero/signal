import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { POST as slackEvents } from "../../src/app/api/slack/events/route";
import { POST as githubWebhooks } from "../../src/app/api/github/webhooks/route";
import { POST as slackInteractions } from "../../src/app/api/slack/interactions/route";
import { createSlackEventsHandler, type SlackEventsDependencies } from "../../src/app/api/slack/events/handler";
import { createGitHubWebhookHandler, type GitHubWebhookDependencies } from "../../src/app/api/github/webhooks/handler";
import { createSlackInteractionsHandler, type SlackInteractionsDependencies } from "../../src/app/api/slack/interactions/handler";
import type { Connection, StoredJob } from "../../src/app/api/_lib/ingress";
import { payloadHash, type Mutation } from "../../src/domain/contracts";
import type { ApprovalProposal, ApprovalRequest } from "../../src/services/approve";

const slackSecret = "synthetic-slack-secret";
const githubSecret = "synthetic-github-secret";

function slackRequest(rawBody: string | Uint8Array, path = "events", timestamp = String(Math.floor(Date.now() / 1000))): Request {
  return new Request(`http://localhost/api/slack/${path}`, {
    method: "POST",
    body: rawBody as BodyInit,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", slackSecret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`,
    },
  });
}

async function withSyntheticEnvironment(run: () => Promise<void>): Promise<void> {
  const previous = { SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET, GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET, DATABASE_URL: process.env.DATABASE_URL };
  process.env.SLACK_SIGNING_SECRET = slackSecret;
  process.env.GITHUB_WEBHOOK_SECRET = githubSecret;
  delete process.env.DATABASE_URL;
  try { await run(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Slack observer rejects unsigned requests before touching persistence", async () => {
  const response = await slackEvents(new Request("http://localhost/api/slack/events", {
    method: "POST",
    body: JSON.stringify({ type: "event_callback" }),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid request" });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixtureBase() {
  const after: Array<() => Promise<void>> = [];
  const jobs: StoredJob[] = [];
  let opened = 0;
  let closed = 0;
  const connection: Connection = { db: {} as Connection["db"], pool: { end: async () => { closed += 1; } } };
  return {
    after, jobs, connection,
    counts: () => ({ opened, closed }),
    dependencies: {
      createDb: () => { opened += 1; return connection; },
      after: (work: () => Promise<void>) => { after.push(work); },
      dispatchStoredOutboxJob: async (_db: Connection["db"], job: StoredJob) => { jobs.push(job); return true; },
    },
    flush: async () => { for (const work of after.splice(0)) await work(); },
  };
}

function eventBody(type = "message", overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev1", tenantId: "untrusted-tenant", event: { type, channel: "C1", channel_type: "channel", user: "U1", ts: "1.1", text: "synthetic", ...overrides } });
}

function slackFixture(overrides: Partial<SlackEventsDependencies> = {}) {
  const base = fixtureBase();
  const mappings: unknown[] = [];
  const accepted: unknown[] = [];
  const dependencies: SlackEventsDependencies = {
    ...base.dependencies,
    signingSecret: () => slackSecret,
    resolveSlackObserverTenant: async (_db, input) => { mappings.push(input); return "tenant-1"; },
    acceptMention: async (_db, input) => { accepted.push(input); return { inboxId: "inbox-1", jobId: "job-mention", duplicate: false }; },
    acceptObserverEvent: async (_db, input) => { accepted.push(input); return { eventId: "event-1", jobId: "job-observer", duplicate: false }; },
    ...overrides,
  };
  return { ...base, mappings, accepted, dependencies, handler: createSlackEventsHandler(dependencies) };
}

const githubPayload = { action: "synchronize", repository: { id: 123, full_name: "acme/signal" }, pull_request: { number: 42 }, installation: { id: 7 }, sender: { login: "rob", type: "User" }, tenantId: "untrusted-tenant" };
const githubBody = JSON.stringify(githubPayload);

function githubRequest(rawBody: string | Uint8Array = githubBody, overrides: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/github/webhooks", { method: "POST", body: rawBody as BodyInit, headers: {
    "x-hub-signature-256": `sha256=${createHmac("sha256", githubSecret).update(rawBody).digest("hex")}`,
    "x-github-event": "pull_request", "x-github-delivery": "delivery-1", ...overrides,
  } });
}

function githubFixture(overrides: Partial<GitHubWebhookDependencies> = {}) {
  const base = fixtureBase();
  const mappings: unknown[] = [];
  const accepted: unknown[] = [];
  const dependencies: GitHubWebhookDependencies = {
    ...base.dependencies, webhookSecret: () => githubSecret,
    resolveGitHubObserverTenant: async (_db, input) => { mappings.push(input); return "tenant-1"; },
    acceptObserverEvent: async (_db, input) => { accepted.push(input); return { eventId: "event-1", jobId: "job-observer", duplicate: false }; },
    ...overrides,
  };
  return { ...base, mappings, accepted, dependencies, handler: createGitHubWebhookHandler(dependencies) };
}

test("Slack signed challenge authenticates before parsing and needs no database", async () => {
  const fixture = slackFixture();
  const raw = '{ "type": "url_verification", "challenge": "challenge-1" }';
  const good = await fixture.handler(slackRequest(raw));
  assert.deepEqual(await good.json(), { challenge: "challenge-1" });
  const altered = slackRequest(`${raw} `);
  altered.headers.set("x-slack-signature", slackRequest(raw).headers.get("x-slack-signature")!);
  assert.equal((await fixture.handler(altered)).status, 401);
  assert.equal((await fixture.handler(slackRequest("{"))).status, 400);
  const unsignedMalformed = slackRequest("{");
  unsignedMalformed.headers.delete("x-slack-signature");
  assert.equal((await fixture.handler(unsignedMalformed)).status, 401);
  assert.deepEqual(fixture.counts(), { opened: 0, closed: 0 });
});

test("Slack timestamp window rejects stale, future and malformed delivery timestamps", async () => {
  const fixture = slackFixture();
  const seconds = Math.floor(Date.now() / 1000);
  for (const timestamp of [String(seconds - 301), String(seconds + 301), "NaN", "1.5", "", "9007199254740992"]) {
    assert.equal((await fixture.handler(slackRequest(eventBody(), "events", timestamp))).status, 401);
  }
  assert.equal(fixture.counts().opened, 0);
});

test("raw byte HMAC rejects BOM stripping and lossy UTF-8 substitution on both providers", async () => {
  for (const provider of ["slack", "github"] as const) {
    const fixture = provider === "slack" ? slackFixture() : githubFixture();
    const requestFor = provider === "slack" ? slackRequest : githubRequest;
    const header = provider === "slack" ? "x-slack-signature" : "x-hub-signature-256";
    for (const [bytes, replacement] of [[Buffer.from([0xff]), "\ufffd"], [Buffer.from("\ufeff{}"), "{}"]] as const) {
      const request = requestFor(bytes);
      request.headers.set(header, requestFor(replacement).headers.get(header)!);
      assert.equal((await fixture.handler(request)).status, 401);
      assert.equal((await fixture.handler(requestFor(bytes))).status, 400);
    }
    assert.equal(fixture.counts().opened, 0);
  }
});

test("shared channels, bots, DMs and unsupported events never reach Slack persistence", async () => {
  const fixture = slackFixture();
  for (const type of ["message", "app_mention"]) {
    for (const overrides of [{ is_shared: true }, { is_ext_shared_channel: true }, { channel_type: "shared" }, { channel: "D1" }, { channel_type: "mpim" }, { bot_id: "B1" }, { app_id: "A1" }, { subtype: "message_changed" }]) {
      assert.equal((await fixture.handler(slackRequest(eventBody(type, overrides)))).status, 202);
    }
    assert.equal((await fixture.handler(slackRequest(eventBody(type, { is_shared: "false" })))).status, 400);
    assert.equal((await fixture.handler(slackRequest(eventBody(type, { user: "bad-user" })))).status, 400);
  }
  assert.equal((await fixture.handler(slackRequest(eventBody("reaction_added")))).status, 202);
  assert.equal(fixture.counts().opened, 0);
});

test("Slack resolves server tenant and acknowledges each kind only after atomic acceptance", async () => {
  for (const type of ["message", "app_mention"]) {
    const gate = deferred<{ eventId: string; inboxId: string; jobId: string; duplicate: boolean }>();
    const entered = deferred<void>();
    const accepted: unknown[] = [];
    const accept = async (_db: Connection["db"], input: unknown) => { accepted.push(input); entered.resolve(); return gate.promise; };
    const fixture = slackFixture({ acceptMention: accept, acceptObserverEvent: accept });
    let returned = false;
    const response = fixture.handler(slackRequest(eventBody(type))).then((value) => { returned = true; return value; });
    await entered.promise;
    assert.equal(returned, false);
    assert.equal(fixture.after.length, 0);
    assert.deepEqual(fixture.mappings, [{ slackTeamId: "T1", channelId: "C1" }]);
    const input = accepted[0] as Record<string, unknown>;
    assert.equal(input.tenantId, "tenant-1");
    for (const key of ["rawBody", "text", "payload", "prompt"]) assert.equal(key in input, false);
    if (type === "message") assert.equal(input.payloadHash, createHash("sha256").update(eventBody(type)).digest("hex"));
    gate.resolve({ eventId: "event-1", inboxId: "inbox-1", jobId: "job-1", duplicate: false });
    assert.deepEqual(await (await response).json(), { ok: true, duplicate: false });
    assert.equal(fixture.jobs.length, 0);
    assert.equal(fixture.counts().closed, 0);
    await fixture.flush();
    assert.deepEqual(fixture.jobs, [{ tenantId: "tenant-1", jobId: "job-1", taskId: type === "message" ? "signal.observe-event" : "signal.analyze-thread", schemaVersion: 1 }]);
    assert.equal(fixture.counts().closed, 1);
  }
});

test("observer mappings fail closed and persistence/setup errors remain sanitized", async () => {
  for (const provider of ["slack", "github"] as const) {
    for (const tenantId of [null, "", " ", " tenant-1"]) {
      const fixture = provider === "slack" ? slackFixture({ resolveSlackObserverTenant: async () => tenantId }) : githubFixture({ resolveGitHubObserverTenant: async () => tenantId });
      const response = await fixture.handler(provider === "slack" ? slackRequest(eventBody()) : githubRequest());
      assert.equal(response.status, 202);
      assert.equal(fixture.accepted.length, 0);
      await fixture.flush();
      assert.equal(fixture.jobs.length, 0);
    }
    for (const failure of ["setup", "mapping", "insert", "missing_job"] as const) {
      const fail = async () => { throw new Error("synthetic-secret-error"); };
      const common = failure === "setup" ? { createDb: () => { throw new Error("synthetic-secret-error"); } }
        : failure === "insert" ? { acceptObserverEvent: fail }
        : failure === "missing_job" ? { acceptObserverEvent: async () => ({ eventId: "event-1", jobId: "", duplicate: true }) } : {};
      const fixture = provider === "slack" ? slackFixture({ ...common, ...(failure === "mapping" ? { resolveSlackObserverTenant: fail } : {}) })
        : githubFixture({ ...common, ...(failure === "mapping" ? { resolveGitHubObserverTenant: fail } : {}) });
      const response = await fixture.handler(provider === "slack" ? slackRequest(eventBody()) : githubRequest());
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes("synthetic-secret-error"), false);
      await fixture.flush();
      assert.equal(fixture.jobs.length, 0);
    }
  }
});

test("exact replay forwards only the original persisted job for both Slack intake kinds and GitHub", async () => {
  for (const kind of ["message", "app_mention", "github"]) {
    let count = 0;
    const accept = async () => ({ eventId: "event-1", inboxId: "inbox-1", jobId: "original-job", duplicate: count++ > 0 });
    const fixture = kind === "github" ? githubFixture({ acceptObserverEvent: accept }) : slackFixture({ acceptMention: accept, acceptObserverEvent: accept });
    for (let index = 0; index < 2; index++) {
      const response = await fixture.handler(kind === "github" ? githubRequest() : slackRequest(eventBody(kind)));
      assert.deepEqual(await response.json(), { ok: true, duplicate: index > 0 });
      await fixture.flush();
    }
    assert.equal(fixture.jobs.length, 2);
    assert.deepEqual(fixture.jobs[0], fixture.jobs[1]);
  }
});

test("GitHub authenticates malformed JSON before parse and validates required event coordinates", async () => {
  const fixture = githubFixture();
  const unsigned = githubRequest("{");
  unsigned.headers.delete("x-hub-signature-256");
  assert.equal((await fixture.handler(unsigned)).status, 401);
  for (const raw of ["{", "null", "[]", "42", "{}", JSON.stringify({ ...githubPayload, repository: { id: 123, full_name: "acme/signal/extra" } }), JSON.stringify({ ...githubPayload, installation: null })]) {
    assert.equal((await fixture.handler(githubRequest(raw))).status, 400);
  }
  assert.equal((await fixture.handler(githubRequest(githubBody, { "x-github-delivery": "" }))).status, 400);
  assert.equal((await fixture.handler(githubRequest(githubBody, { "x-github-delivery": "bad delivery" }))).status, 400);
  assert.equal((await fixture.handler(githubRequest(githubBody, { "x-github-event": "push" }))).status, 202);
  assert.equal((await fixture.handler(githubRequest(JSON.stringify({ ...githubPayload, action: "assigned" })))).status, 202);
  assert.equal((await fixture.handler(githubRequest(JSON.stringify({ ...githubPayload, sender: { login: "dependabot[bot]", type: "Bot" } })))).status, 202);
  assert.equal(fixture.counts().opened, 0);
});

test("GitHub waits for durable event/job acceptance and dispatches IDs after response", async () => {
  const gate = deferred<{ eventId: string; jobId: string; duplicate: boolean }>();
  const entered = deferred<void>();
  let input: Record<string, unknown> | undefined;
  const fixture = githubFixture({ acceptObserverEvent: async (_db, value) => { input = value; entered.resolve(); return gate.promise; } });
  let returned = false;
  const response = fixture.handler(githubRequest()).then((value) => { returned = true; return value; });
  await entered.promise;
  assert.equal(returned, false);
  assert.deepEqual(fixture.mappings, [{ repositoryId: "123", installationId: "7" }]);
  assert.equal(input?.tenantId, "tenant-1");
  assert.equal(input?.payloadHash, createHash("sha256").update(githubBody).digest("hex"));
  for (const key of ["rawBody", "body", "payload", "prompt"]) assert.equal(key in input!, false);
  gate.resolve({ eventId: "event-1", jobId: "job-1", duplicate: false });
  assert.equal((await response).status, 200);
  assert.equal(fixture.jobs.length, 0);
  await fixture.flush();
  assert.deepEqual(fixture.jobs, [{ tenantId: "tenant-1", jobId: "job-1", taskId: "signal.observe-event", schemaVersion: 1 }]);
});

test("observer deadline returns 503 without late dispatch or successful acknowledgment", async () => {
  for (const provider of ["slack", "github"] as const) {
    const gate = deferred<{ eventId: string; jobId: string; duplicate: boolean }>();
    const fixture = provider === "slack" ? slackFixture({ timeoutMs: 15, acceptObserverEvent: () => gate.promise }) : githubFixture({ timeoutMs: 15, acceptObserverEvent: () => gate.promise });
    const response = await fixture.handler(provider === "slack" ? slackRequest(eventBody()) : githubRequest());
    assert.equal(response.status, 503);
    gate.resolve({ eventId: "event-1", jobId: "late-job", duplicate: false });
    await fixture.flush();
    assert.equal(fixture.jobs.length, 0);
  }
});

test("hung dispatch/cleanup cannot delay acknowledgement and failures do not reject after work", async () => {
  for (const provider of ["slack", "github"] as const) {
    const dispatchGate = deferred<boolean>();
    const fixture = provider === "slack" ? slackFixture({ dispatchStoredOutboxJob: () => dispatchGate.promise }) : githubFixture({ dispatchStoredOutboxJob: () => dispatchGate.promise });
    fixture.connection.pool.end = async () => { throw new Error("synthetic-secret-error"); };
    assert.equal((await fixture.handler(provider === "slack" ? slackRequest(eventBody()) : githubRequest())).status, 200);
    const flushing = fixture.flush();
    dispatchGate.resolve(false);
    await assert.doesNotReject(flushing);
    const fail = async () => { throw new Error("synthetic-secret-error"); };
    const failed = provider === "slack" ? slackFixture({ dispatchStoredOutboxJob: fail }) : githubFixture({ dispatchStoredOutboxJob: fail });
    assert.equal((await failed.handler(provider === "slack" ? slackRequest(eventBody()) : githubRequest())).status, 200);
    await assert.doesNotReject(failed.flush());
    assert.equal(failed.counts().closed, 1);
  }
});

test("GitHub observer rejects unsigned requests before touching persistence", async () => {
  const response = await githubWebhooks(new Request("http://localhost/api/github/webhooks", {
    method: "POST",
    body: JSON.stringify({ action: "opened" }),
  }));
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_request");
  assert.equal(typeof body.error.requestId, "string");
});

test("signed non-object Slack JSON returns 400 without throwing", async () => {
  await withSyntheticEnvironment(async () => {
    for (const raw of ["null", "[]", "42", '"text"', '{"type":"url_verification","challenge":{}}']) {
      assert.equal((await slackEvents(slackRequest(raw))).status, 400);
    }
  });
});

test("signed malformed interactions return 400 before database setup", async () => {
  await withSyntheticEnvironment(async () => {
    assert.equal((await slackInteractions(slackRequest("payload=null", "interactions"))).status, 400);
  });
});

test("signed accepted Slack event sanitizes database setup failure", async () => {
  await withSyntheticEnvironment(async () => {
    const raw = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev1", event: { type: "message", channel: "C1", user: "U1", ts: "1.1", text: "synthetic" } });
    const response = await slackEvents(slackRequest(raw));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Observer unavailable" });
  });
});

test("GitHub rejects an invalid UTF-8 body signed as its lossy decoded replacement", async () => {
  await withSyntheticEnvironment(async () => {
    const bytes = Buffer.from([0xff]);
    const response = await githubWebhooks(new Request("http://localhost/api/github/webhooks", {
      method: "POST", body: bytes,
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", githubSecret).update("\ufffd").digest("hex")}` },
    }));
    assert.equal(response.status, 401);
  });
});

function interactionFixture(overrides: Partial<SlackInteractionsDependencies> = {}, repositoryOverrides: Partial<SlackInteractionsDependencies["repository"]> = {}) {
  const base = fixtureBase();
  const mutation: Mutation = { kind: "CREATE_ISSUE", repoId: "repo-1", owner: "acme", repo: "signal", title: "Synthetic task", body: "Synthetic body\n<!-- signal-operation:op-1 -->", assignees: [] };
  const proposal: ApprovalProposal = {
    tenantId: "tenant-1", proposalId: "proposal-1", operationId: "op-1", version: 1,
    payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId: "op-1", version: 1, mutation }),
    expiresAt: new Date(Date.now() + 60_000), state: "PENDING", slackTeamId: "T1", channelId: "C1", mutation,
  };
  const binding = { tenantId: proposal.tenantId, proposalId: proposal.proposalId, operationId: proposal.operationId, version: proposal.version, payloadHash: proposal.payloadHash, expiresAt: proposal.expiresAt.toISOString(), slackTeamId: proposal.slackTeamId, channelId: proposal.channelId };
  const review = { tenantId: "tenant-1", proposalId: "proposal-1", modalId: "V1", actorSlackId: "U1", slackTeamId: "T1", channelId: "C1", version: 1 };
  const approvals: ApprovalRequest[] = [];
  const opened: unknown[] = [];
  const recorded: unknown[] = [];
  const dependencies: SlackInteractionsDependencies = {
    ...base.dependencies, signingSecret: () => slackSecret, botToken: () => "synthetic-token",
    createSlackApiClient: () => ({
      openModal: async (input) => { opened.push(input); return { viewId: "V1" }; },
      updateMessage: async () => { throw new Error("unexpected provider call"); },
      postMessage: async () => { throw new Error("unexpected provider call"); },
    }),
    repository: {
      resolveActiveSlackTenant: async () => "tenant-1",
      loadProposalForApproval: async () => proposal,
      isNamedApprover: async () => true,
      loadSlackReview: async () => review,
      recordSlackReview: async (_db, input) => { recorded.push(input); },
      approveProposal: async (_db, input) => { approvals.push(input as ApprovalRequest); return { approvalId: "approval-1", jobId: "job-1" }; },
      dismissProposal: async () => {},
      ...repositoryOverrides,
    },
    ...overrides,
  };
  const form = (payload: unknown) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const block = () => form({ type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" }, trigger_id: "1.2", actions: [{ action_id: "signal.review_proposal", value: "proposal-1:1" }] });
  const submit = (metadata: unknown = binding, modalId = "V1", userId = "U1") => form({ type: "view_submission", team: { id: "T1" }, user: { id: userId }, view: { id: modalId, callback_id: "signal.approve_proposal", private_metadata: JSON.stringify(metadata) } });
  return { ...base, proposal, binding, review, approvals, opened, recorded, dependencies, block, submit, handler: createSlackInteractionsHandler(dependencies) };
}

test("interaction ingress rejects unsigned, tampered, stale and malformed forms before database use", async () => {
  const fixture = interactionFixture();
  const unsigned = slackRequest("payload={", "interactions");
  unsigned.headers.delete("x-slack-signature");
  assert.equal((await fixture.handler(unsigned)).status, 401);
  const tampered = slackRequest(fixture.submit(), "interactions");
  tampered.headers.set("x-slack-signature", `v0=${"0".repeat(64)}`);
  assert.equal((await fixture.handler(tampered)).status, 401);
  assert.equal((await fixture.handler(slackRequest(fixture.submit(), "interactions", String(Math.floor(Date.now() / 1000) - 301)))).status, 401);
  for (const raw of ["payload={", "payload=null", "payload=[]", "payload={}&payload={}", "no_payload=true"]) {
    assert.equal((await fixture.handler(slackRequest(raw, "interactions"))).status, 400);
  }
  assert.equal(fixture.counts().opened, 0);
  assert.equal(fixture.approvals.length, 0);
  assert.equal(fixture.opened.length, 0);
});

test("review opens the exact persisted modal and records its returned id before success", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const fixture = interactionFixture({}, { recordSlackReview: async () => { entered.resolve(); return gate.promise; } });
  let returned = false;
  const response = fixture.handler(slackRequest(fixture.block(), "interactions")).then((value) => { returned = true; return value; });
  await entered.promise;
  assert.equal(returned, false);
  const opened = fixture.opened[0] as { triggerId: string; modal: { private_metadata: string; submit: unknown } };
  assert.equal(opened.triggerId, "1.2");
  assert.deepEqual(JSON.parse(opened.modal.private_metadata), fixture.binding);
  assert.ok(opened.modal.submit);
  gate.resolve();
  assert.equal((await response).status, 200);
  assert.equal(fixture.approvals.length, 0);
  await fixture.flush();
  assert.equal(fixture.jobs.length, 0);
});

test("unauthorized review uses the accepted openNotice adapter without approval or dispatch", async () => {
  const fixture = interactionFixture({}, { isNamedApprover: async () => false });
  const response = await fixture.handler(slackRequest(fixture.block(), "interactions"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, error: "approval_unauthorized" });
  assert.equal(fixture.opened.length, 1);
  const notice = fixture.opened[0] as { triggerId: string; modal: Record<string, unknown> };
  assert.equal(notice.triggerId, "1.2");
  for (const key of ["submit", "callback_id", "private_metadata"]) assert.equal(key in notice.modal, false);
  assert.equal(fixture.approvals.length, 0);
  assert.equal(fixture.recorded.length, 0);
  await fixture.flush();
  assert.equal(fixture.jobs.length, 0);
});

test("approval forwards canonical binding plus modalId and waits for durable result", async () => {
  const gate = deferred<{ approvalId: string; jobId: string }>();
  const entered = deferred<void>();
  let actual: unknown;
  const fixture = interactionFixture({}, { approveProposal: async (_db, input) => { actual = input; entered.resolve(); return gate.promise; } });
  let returned = false;
  const response = fixture.handler(slackRequest(fixture.submit(), "interactions")).then((value) => { returned = true; return value; });
  await entered.promise;
  assert.equal(returned, false);
  assert.equal(fixture.after.length, 0);
  assert.deepEqual(actual, { ...fixture.binding, actorSlackId: "U1", modalId: "V1" });
  gate.resolve({ approvalId: "approval-1", jobId: "job-1" });
  assert.deepEqual(await (await response).json(), { response_action: "clear" });
  assert.equal(fixture.jobs.length, 0);
  await fixture.flush();
  assert.deepEqual(fixture.jobs, [{ tenantId: "tenant-1", jobId: "job-1", taskId: "signal.execute-operation", schemaVersion: 1 }]);
});

test("approval replay forwards the same persisted job and has no provider write capability", async () => {
  const fixture = interactionFixture();
  for (let index = 0; index < 2; index++) {
    const response = await fixture.handler(slackRequest(fixture.submit(), "interactions"));
    assert.deepEqual(await response.json(), { response_action: "clear" });
    await fixture.flush();
  }
  assert.equal(fixture.jobs.length, 2);
  assert.deepEqual(fixture.jobs[0], fixture.jobs[1]);
  assert.equal(fixture.opened.length, 0);
});

test("unmapped and forged tenant/modal/actor/binding submissions cannot approve", async () => {
  for (const scenario of ["unmapped", "tenant", "modal", "actor", "hash", "version", "expiry"]) {
    const fixture = interactionFixture({}, scenario === "unmapped" ? { resolveActiveSlackTenant: async () => null } : {});
    const binding = { ...fixture.binding, ...(scenario === "tenant" ? { tenantId: "another-tenant" } : {}), ...(scenario === "hash" ? { payloadHash: "a".repeat(64) } : {}), ...(scenario === "version" ? { version: 2 } : {}), ...(scenario === "expiry" ? { expiresAt: new Date(Date.now() + 120_000).toISOString() } : {}) };
    const response = await fixture.handler(slackRequest(fixture.submit(binding, scenario === "modal" ? "V2" : "V1", scenario === "actor" ? "U2" : "U1"), "interactions"));
    assert.notDeepEqual(await response.json(), { response_action: "clear" });
    assert.equal(fixture.approvals.length, 0, scenario);
    await fixture.flush();
    assert.equal(fixture.jobs.length, 0);
  }
});

test("failed approval persistence never clears a modal or schedules execution", async () => {
  const fixture = interactionFixture({}, { approveProposal: async () => { throw new Error("synthetic-secret-error"); } });
  const response = await fixture.handler(slackRequest(fixture.submit(), "interactions"));
  const body = await response.json();
  assert.notEqual(body.response_action, "clear");
  assert.equal(JSON.stringify(body).includes("synthetic-secret-error"), false);
  await fixture.flush();
  assert.equal(fixture.jobs.length, 0);
});

test("interaction database failures and a stalled modal remain bounded and sanitized", async () => {
  const broken = interactionFixture({ createDb: () => { throw new Error("synthetic-secret-error"); } });
  const failure = await broken.handler(slackRequest(broken.submit(), "interactions"));
  assert.equal(failure.status, 503);
  assert.equal((await failure.text()).includes("synthetic-secret-error"), false);
  const gate = deferred<{ viewId: string }>();
  let signal: AbortSignal | undefined;
  const stalled = interactionFixture({ timeoutMs: 15, createSlackApiClient: (options) => {
    signal = options.signal;
    return { openModal: () => gate.promise, updateMessage: async () => {}, postMessage: async () => { throw new Error("unexpected"); } };
  } });
  const response = await stalled.handler(slackRequest(stalled.block(), "interactions"));
  assert.equal(response.status, 503);
  assert.equal(signal?.aborted, true);
  gate.resolve({ viewId: "V1" });
  await stalled.flush();
  assert.equal(stalled.recorded.length, 0);
  assert.equal(stalled.jobs.length, 0);
});

test("body limits and stalled streams terminate before persistence", async () => {
  const fixtures = [
    { handler: slackFixture().handler, request: slackRequest("x".repeat(1024 * 1024 + 1)) },
    { handler: githubFixture().handler, request: githubRequest("x".repeat(1024 * 1024 + 1)) },
    { handler: interactionFixture().handler, request: slackRequest("x".repeat(64 * 1024 + 1), "interactions") },
  ];
  for (const { handler, request } of fixtures) assert.equal((await handler(request)).status, 413);
  const signed = slackRequest("");
  let cancelled = false;
  const request = new Request(signed.url, {
    method: "POST", headers: signed.headers,
    body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
    duplex: "half",
  } as RequestInit);
  const fixture = slackFixture({ timeoutMs: 15 });
  assert.equal((await fixture.handler(request)).status, 503);
  assert.equal(cancelled, true);
  assert.equal(fixture.counts().opened, 0);
});

test("post-response registration failure preserves durable acceptance and never runs foreground dispatch", async () => {
  const fixture = slackFixture({ after: () => { throw new Error("synthetic-secret-error"); } });
  const response = await fixture.handler(slackRequest(eventBody()));
  assert.equal(response.status, 200);
  assert.equal(fixture.jobs.length, 0);
  assert.equal(fixture.counts().closed, 1);
});

test("hung pool drain is entirely outside Slack acknowledgement", async () => {
  const gate = deferred<void>();
  const fixture = slackFixture();
  fixture.connection.pool.end = () => gate.promise;
  const response = await fixture.handler(slackRequest(eventBody()));
  assert.equal(response.status, 200);
  const draining = fixture.flush();
  gate.resolve();
  await draining;
});

test("late tenant resolution cannot start an insert after the request deadline", async () => {
  const gate = deferred<string | null>();
  const fixture = slackFixture({ timeoutMs: 15, resolveSlackObserverTenant: () => gate.promise });
  assert.equal((await fixture.handler(slackRequest(eventBody()))).status, 503);
  gate.resolve("tenant-1");
  await fixture.flush();
  assert.equal(fixture.accepted.length, 0);
  assert.equal(fixture.jobs.length, 0);
});
