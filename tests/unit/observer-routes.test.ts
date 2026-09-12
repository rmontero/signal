import assert from "node:assert/strict";
import test from "node:test";

import { POST as slackEvents } from "../../src/app/api/slack/events/route";
import { POST as githubWebhooks } from "../../src/app/api/github/webhooks/route";

test("Slack observer rejects unsigned requests before touching persistence", async () => {
  const response = await slackEvents(new Request("http://localhost/api/slack/events", {
    method: "POST",
    body: JSON.stringify({ type: "event_callback" }),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid request" });
});

test("GitHub observer rejects unsigned requests before touching persistence", async () => {
  const response = await githubWebhooks(new Request("http://localhost/api/github/webhooks", {
    method: "POST",
    body: JSON.stringify({ action: "opened" }),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid request" });
});
