import assert from "node:assert/strict";
import test from "node:test";
import { parsePilotConfig } from "../../src/config/pilot";

const valid = {
  tenantId: "tenant-signal",
  slackTeamId: "T12345678",
  workspaceTimezone: "America/Mexico_City",
  channels: [{ channelId: "C12345678", githubInstallationId: "install-1", githubRepoId: "repo-1", githubOwner: "rmontero", githubRepo: "signal", approverSlackIds: ["U12345678"] }],
  identities: [{ slackUserId: "U12345678", githubLogin: "rmontero" }],
  auth0Subjects: [],
};

test("pilot config validates provider coordinates and returns a normalized object", () => {
  assert.equal(parsePilotConfig(valid).channels[0]?.githubRepo, "signal");
});

test("pilot config rejects duplicate channel approver and identity entries", () => {
  assert.throws(() => parsePilotConfig({ ...valid, channels: [...valid.channels, valid.channels[0]] }), /pilot_duplicate_channel/);
  assert.throws(() => parsePilotConfig({ ...valid, channels: [{ ...valid.channels[0], approverSlackIds: ["U12345678", "U12345678"] }] }), /pilot_duplicate_approver/);
  assert.throws(() => parsePilotConfig({ ...valid, identities: [...valid.identities, valid.identities[0]] }), /pilot_duplicate_identity/);
});

test("pilot config requires at least one named approver per channel", () => {
  assert.throws(() => parsePilotConfig({ ...valid, channels: [{ ...valid.channels[0], approverSlackIds: [] }] }));
});

test("pilot config rejects absent identity and unknown authority fields", () => {
  for (const input of [null, [], {}, { ...valid, tenantId: " " }, { ...valid, slackTeamId: "bad-team" }, { ...valid, channels: [] }, { ...valid, admin: true }, { ...valid, channels: [{ ...valid.channels[0], allowAllApprovers: true }] }, { ...valid, identities: [{ ...valid.identities[0], tenantId: "other-tenant" }] }]) {
    assert.throws(() => parsePilotConfig(input));
  }
});

test("pilot channel mapping requires each configured repository and installation coordinate", () => {
  for (const key of ["channelId", "githubInstallationId", "githubRepoId", "githubOwner", "githubRepo"] as const) {
    for (const value of [undefined, null, "", " "]) {
      assert.throws(() => parsePilotConfig({ ...valid, channels: [{ ...valid.channels[0], [key]: value }] }));
    }
  }
});

test("pilot has no implicit Auth0 mapping and scopes repeated approvers to their channels", () => {
  assert.deepEqual(parsePilotConfig({ ...valid, auth0Subjects: undefined }).auth0Subjects, []);
  const config = parsePilotConfig({ ...valid, channels: [...valid.channels, { ...valid.channels[0], channelId: "C87654321" }] });
  assert.equal(config.channels.length, 2);
  assert.deepEqual(config.channels[0].approverSlackIds, config.channels[1].approverSlackIds);
});
