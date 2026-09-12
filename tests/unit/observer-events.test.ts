import assert from "node:assert/strict";
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
