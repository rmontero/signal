import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  classifyGitHubPullRequestWebhook,
  verifyGitHubWebhookSignature,
} from "../../src/adapters/github-webhook";

const body = JSON.stringify({
  action: "synchronize",
  repository: { id: 123, full_name: "acme/signal" },
  pull_request: { number: 42 },
  installation: { id: 7 },
  sender: { login: "rob" },
});

function signatureFor(rawBody: string): string {
  return `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`;
}

test("verifies the exact GitHub webhook body", async () => {
  const signature = signatureFor(body);
  assert.deepEqual(
    await verifyGitHubWebhookSignature({ secret: "github-secret", rawBody: body, signature }),
    { ok: true },
  );
  assert.deepEqual(
    await verifyGitHubWebhookSignature({ secret: "github-secret", rawBody: `${body} `, signature }),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    await verifyGitHubWebhookSignature({ secret: "", rawBody: body, signature }),
    { ok: false, reason: "missing_secret" },
  );
});

test("accepts only supported pull-request events and exposes safe coordinates", () => {
  assert.deepEqual(
    classifyGitHubPullRequestWebhook(body, { event: "pull_request", delivery: "delivery-1" }),
    {
      kind: "pull_request",
      deliveryId: "delivery-1",
      action: "synchronize",
      repositoryId: "123",
      owner: "acme",
      repo: "signal",
      installationId: "7",
      pullRequestNumber: 42,
      senderLogin: "rob",
    },
  );

  assert.deepEqual(
    classifyGitHubPullRequestWebhook(body, { event: "push", delivery: "delivery-2" }),
    { kind: "ignore", reason: "unsupported_event" },
  );
  assert.deepEqual(
    classifyGitHubPullRequestWebhook("{}", { event: "pull_request", delivery: "delivery-3" }),
    { kind: "ignore", reason: "missing_fields" },
  );
});
