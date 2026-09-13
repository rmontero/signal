import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createObserverEventInput } from "../../src/domain/observer-events.ts";

test("stores only provider coordinates and a hash for observer dispatch", () => {
  const input = createObserverEventInput({
    tenantId: "tenant-1",
    source: "slack",
    providerEventId: "Ev10",
    eventType: "message",
    channelId: "C1",
    threadTs: "1.0",
    messageTs: "1.1",
    actorId: "U1",
    rawBody: '{"text":"private source text"}',
  });

  assert.equal(input.tenantId, "tenant-1");
  assert.equal(input.providerEventId, "Ev10");
  assert.equal(input.payloadHash.length, 64);
  assert.equal("rawBody" in input, false);
  assert.equal("text" in input, false);
});

test("observer hash covers exact UTF-8 bytes without normalization", () => {
  const bodies = ['{"text":"café"}', '{ "text": "café" }', '{"text":"cafe\u0301"}', "line\r\nnext", "line\nnext"];
  const hashes = bodies.map((rawBody) => {
    const input = createObserverEventInput({ tenantId: "tenant-1", source: "slack", providerEventId: "Ev1", eventType: "message", channelId: "C1", threadTs: "1.0", messageTs: "1.1", rawBody });
    assert.equal(input.payloadHash, createHash("sha256").update(rawBody).digest("hex"));
    assert.equal(input.actorId, null);
    assert.equal(input.repositoryId, null);
    assert.equal(input.repositoryOwner, null);
    assert.equal(input.installationId, null);
    return input.payloadHash;
  });
  assert.equal(new Set(hashes).size, bodies.length);
});

test("observer input rejects absent tenant and delivery identity and does not echo source", () => {
  const valid = { tenantId: "tenant-1", source: "slack" as const, providerEventId: "Ev1", eventType: "message", channelId: "C1", threadTs: "1.0", messageTs: "1.1", rawBody: "synthetic-private-source" };
  for (const key of ["tenantId", "providerEventId", "eventType"] as const) {
    for (const value of ["", " "]) {
      assert.throws(() => createObserverEventInput({ ...valid, [key]: value }), (error: unknown) => error instanceof Error && error.message === "Observer event identity is required");
    }
  }
  const result = createObserverEventInput({ ...valid, payload: "synthetic-private-source", prompt: "synthetic-private-source" } as typeof valid);
  assert.equal(JSON.stringify(result).includes("synthetic-private-source"), false);
});

test("normalizes pull-request observer coordinates without carrying source payload", () => {
  const input = createObserverEventInput({
    tenantId: "tenant-1",
    source: "github",
    providerEventId: "delivery-1",
    eventType: "pull_request",
    repositoryId: "123",
    repositoryOwner: "rmontero",
    repositoryName: "signal",
    installationId: "7",
    pullRequestNumber: 42,
    actorId: "rob",
    rawBody: '{"body":"private source text"}',
  });

  assert.equal(input.tenantId, "tenant-1");
  assert.equal(input.source, "github");
  assert.equal(input.repositoryOwner, "rmontero");
  assert.equal(input.repositoryName, "signal");
  assert.equal(input.pullRequestNumber, 42);
  assert.match(input.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal("rawBody" in input, false);
  assert.equal("body" in input, false);
});
