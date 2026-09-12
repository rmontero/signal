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
