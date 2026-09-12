import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackApiClient } from "../src/adapters/slack-api";

test("Slack API adapter updates results and opens modals without retries", async () => {
  const calls: Array<{ method: string; body: string }> = [];
  const client = createSlackApiClient({ botToken: "xoxb-secret", apiBaseUrl: "https://slack.test/api", fetchImpl: async (url, init) => {
    calls.push({ method: String(url), body: String(init?.body) });
    return new Response(JSON.stringify(calls.length === 1 ? { ok: true } : { ok: true, view: { id: "V1" } }), { status: 200 });
  } });
  await client.updateMessage({ channelId: "C1", messageTs: "1.2", text: "done" });
  const modal = await client.openModal({ triggerId: "1.2", modal: { type: "modal", callback_id: "signal.approve_proposal", private_metadata: "{}", title: { type: "plain_text", text: "Review" }, submit: { type: "plain_text", text: "Approve" }, close: { type: "plain_text", text: "Cancel" }, blocks: [] } });
  assert.equal(modal.viewId, "V1");
  assert.match(calls[0].method, /chat\.update/);
  assert.doesNotMatch(calls[0].body, /xoxb-secret/);
});
