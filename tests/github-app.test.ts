import assert from "node:assert/strict";
import { test } from "node:test";
import { mintGitHubInstallationToken } from "../src/adapters/github-app";

test("rejects GitHub App credentials before any provider request", async () => {
  await assert.rejects(mintGitHubInstallationToken({ appId: "not-an-id", privateKey: "key" }, "123"), /github_app_configuration_invalid/);
  await assert.rejects(mintGitHubInstallationToken({ appId: "123", privateKey: "key" }, "123"), /github_app_configuration_invalid/);
  await assert.rejects(mintGitHubInstallationToken({ appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----" }, "not-an-installation"), /github_installation_invalid/);
});
