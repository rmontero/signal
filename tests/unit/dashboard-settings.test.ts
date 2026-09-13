import assert from "node:assert/strict";
import test from "node:test";

import { dashboardSectionFromHash, getConnectorStatuses, type ConnectorEnvironment } from "../../src/lib/dashboard-settings.ts";

test("maps supported sidebar hashes and defaults unknown hashes to overview", () => {
  assert.equal(dashboardSectionFromHash("#settings"), "settings");
  assert.equal(dashboardSectionFromHash("#decisions"), "decisions");
  assert.equal(dashboardSectionFromHash("#not-a-section"), "overview");
  assert.equal(dashboardSectionFromHash(""), "overview");
});

test("reports configuration presence without claiming live integration or exposing values", () => {
  const env: ConnectorEnvironment = {
    DATABASE_URL: "database-url",
    SIGNAL_DASHBOARD_TENANT_ID: "tenant-1",
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-token",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_LOGIN: "app-login",
    AUTH0_DOMAIN: "tenant.auth0.com",
    AUTH0_CLIENT_ID: "client-id",
    AUTH0_CLIENT_SECRET: "client-secret",
    AUTH0_SECRET: "session-secret",
    TRIGGER_PROJECT_REF: "proj_signal",
    TRIGGER_SECRET_KEY: "tr_secret",
    OPENROUTER_API_KEY: "or-key",
    OPENROUTER_MODEL: "openai/gpt-5.6-luna",
    UPSTASH_REDIS_REST_URL: "https://redis.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "upstash-token",
  };

  const connectors = getConnectorStatuses(env);
  assert.ok(connectors.every(({ status }) => status === "ready"));
  assert.ok(connectors.every(({ detail }) => detail.includes("live verification is pending")));
  for (const value of Object.values(env)) assert.equal(JSON.stringify(connectors).includes(value), false);
  assert.match(connectors.find(({ id }) => id === "auth0")!.detail, /inspector is disabled/);
  assert.match(connectors.find(({ id }) => id === "trigger")!.detail, /do not prove a worker is running/);
  assert.equal(connectors.some(({ id }) => id === "upstash"), false, "Out-of-roadmap Redis is not offered as a connector");

  const partial = getConnectorStatuses({ DATABASE_URL: "database-url" });
  assert.equal(partial.find(({ id }) => id === "neon")?.status, "needs-config");
  assert.equal(partial.find(({ id }) => id === "slack")?.status, "not-configured");
});

test("missing names are stated as blockers and whitespace does not count as configuration", () => {
  const connectors = getConnectorStatuses({ SLACK_BOT_TOKEN: "fixture-token", SLACK_SIGNING_SECRET: " \n " });
  const slack = connectors.find(({ id }) => id === "slack")!;
  assert.equal(slack.status, "needs-config");
  assert.match(slack.detail, /^Missing server configuration: SLACK_SIGNING_SECRET\./);
  assert.equal(slack.detail.includes("fixture-token"), false);
  assert.ok(getConnectorStatuses({}).every(({ status, detail }) => status === "not-configured" && detail.startsWith("Missing server configuration:")));
});

test("GitHub App credentials alone cannot satisfy webhook configuration", () => {
  const github = getConnectorStatuses({ GITHUB_APP_ID: "id", GITHUB_APP_PRIVATE_KEY: "key", GITHUB_APP_LOGIN: "bot" }).find(({ id }) => id === "github")!;
  assert.equal(github.status, "needs-config");
  assert.match(github.detail, /^Missing server configuration: GITHUB_WEBHOOK_SECRET\./);
  assert.ok(github.required.includes("GITHUB_WEBHOOK_SECRET"));
});
