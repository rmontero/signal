import assert from "node:assert/strict";
import test from "node:test";

import { dashboardSectionFromHash, getConnectorStatuses, type ConnectorEnvironment } from "../../src/lib/dashboard-settings.ts";

test("maps supported sidebar hashes and defaults unknown hashes to overview", () => {
  assert.equal(dashboardSectionFromHash("#settings"), "settings");
  assert.equal(dashboardSectionFromHash("#decisions"), "decisions");
  assert.equal(dashboardSectionFromHash("#not-a-section"), "overview");
  assert.equal(dashboardSectionFromHash(""), "overview");
});

test("reports connector readiness without exposing secret values", () => {
  const env: ConnectorEnvironment = {
    DATABASE_URL: "database-url",
    SIGNAL_DASHBOARD_TENANT_ID: "tenant-1",
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "xoxb-token",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
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

  assert.deepEqual(getConnectorStatuses(env), [
    { id: "neon", name: "Neon", category: "Data", status: "ready", detail: "Tenant-scoped database reads are configured.", required: ["DATABASE_URL", "SIGNAL_DASHBOARD_TENANT_ID"] },
    { id: "slack", name: "Slack", category: "Sources", status: "ready", detail: "Signed Events API ingress and bot reads are configured.", required: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"] },
    { id: "github", name: "GitHub", category: "Sources", status: "ready", detail: "GitHub App webhook verification and reads are configured.", required: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] },
    { id: "auth0", name: "Auth0", category: "Access", status: "ready", detail: "Application and session configuration are present.", required: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"] },
    { id: "trigger", name: "Trigger.dev", category: "Runtime", status: "ready", detail: "Background task execution configuration is present.", required: ["TRIGGER_PROJECT_REF", "TRIGGER_SECRET_KEY"] },
    { id: "openrouter", name: "OpenRouter", category: "Intelligence", status: "ready", detail: "The selected Luna model route is configured.", required: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"] },
    { id: "upstash", name: "Upstash", category: "Optional", status: "ready", detail: "Optional Redis configuration is present; it is not required for the MVP observer.", required: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] },
  ]);

  const partial = getConnectorStatuses({ DATABASE_URL: "database-url" });
  assert.equal(partial.find(({ id }) => id === "neon")?.status, "needs-config");
  assert.equal(partial.find(({ id }) => id === "slack")?.status, "not-configured");
});
