import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FULL_CORE_VARIABLES,
  FULL_OPTIONAL_VARIABLES,
  evaluatePreflight,
} from "../../scripts/preflight.ts";

test("default scope contains only supplied recognized names, including newly configured providers", () => {
  const env = Object.freeze({
    DATABASE_URL: "postgres://local-fixture",
    SLACK_BOT_TOKEN: "synthetic-slack-token",
    AUTH0_DOMAIN: "fixture.us.auth0.com",
    EXA_API_KEY: "",
    UNRELATED_SECRET: "synthetic-unrelated-secret",
  });
  const result = evaluatePreflight(env);
  assert.deepEqual(result.required, ["DATABASE_URL", "SLACK_BOT_TOKEN"]);
  assert.deepEqual(result.optional, ["AUTH0_DOMAIN", "EXA_API_KEY"]);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.presentOptional, ["AUTH0_DOMAIN"]);
});

test("unset future providers and an empty environment do not block local checks", () => {
  const result = evaluatePreflight({ DATABASE_URL: undefined });
  assert.deepEqual(result, { required: [], optional: [], missingRequired: [], presentOptional: [] });
  assert.deepEqual(evaluatePreflight({}), result);
});

test("inherited environment names are not supplied configuration", () => {
  const env = Object.create({ DATABASE_URL: "synthetic-inherited-value" }) as NodeJS.ProcessEnv;
  assert.deepEqual(evaluatePreflight(env).required, []);
  assert.ok(evaluatePreflight(env, true).missingRequired.includes("DATABASE_URL"));
});

test("explicit blanks and recognized placeholders fail required checks in both modes", () => {
  const placeholders = ["", " \t\n ", "undefined", "null", "UNSET", "placeholder", "TODO", "TBD", "changeme", "replace-me", "your-api-key", "xxxx", "<api-key>", "${OPENROUTER_KEY}", "postgres://<user>:<password>@host/db"];
  for (const placeholder of placeholders) {
    for (const strict of [false, true]) {
      const result = evaluatePreflight({ OPENROUTER_API_KEY: placeholder }, strict);
      assert.ok(result.required.includes("OPENROUTER_API_KEY"));
      assert.ok(result.missingRequired.includes("OPENROUTER_API_KEY"));
    }
  }
});

test("values are not format-validated, modified, or returned", () => {
  const env = Object.freeze({
    DATABASE_URL: " postgresql://synthetic-host/db ",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nsynthetic-key-material\n-----END PRIVATE KEY-----",
    OPENROUTER_API_KEY: "synthetic-token-containing-null-but-not-a-placeholder",
  });
  const result = evaluatePreflight(env);
  assert.deepEqual(result.missingRequired, []);
  for (const value of Object.values(env)) assert.equal(JSON.stringify(result).includes(value), false);
});

test("strict mode requires the full release list including webhook and pilot configuration", () => {
  const result = evaluatePreflight({ DATABASE_URL: "postgres://fixture" }, true);
  assert.deepEqual(result.required, FULL_CORE_VARIABLES);
  assert.deepEqual(result.optional, FULL_OPTIONAL_VARIABLES);
  assert.deepEqual(result.missingRequired, FULL_CORE_VARIABLES.filter((name) => name !== "DATABASE_URL"));
  for (const name of ["SLACK_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_LOGIN", "CRON_SECRET", "SIGNAL_DASHBOARD_TENANT_ID", "SIGNAL_PILOT_CONFIG_PATH"] as const) {
    assert.ok(result.missingRequired.includes(name));
  }
});

test("a complete strict configuration does not require optional providers", () => {
  const env = Object.fromEntries(FULL_CORE_VARIABLES.map((name) => [name, "synthetic-configured-value"]));
  const result = evaluatePreflight({ ...env, EXA_API_KEY: "<api-key>", AUTH0_SECRET: "", ENABLE_INSPECTOR: "false" }, true);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.presentOptional, ["ENABLE_INSPECTOR"]);
});

function runCli(env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  // Never inherit developer credentials or load .env files in these subprocesses.
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", fileURLToPath(new URL("../../scripts/preflight.ts", import.meta.url)), ...args], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("empty default CLI succeeds and explicitly disclaims readiness", () => {
  const result = runCli();
  assert.equal(result.status, 0);
  assert.match(result.output, /No core configuration names supplied/);
  assert.match(result.output, /release acceptance: NOT RUN/);
});

test("strict CLI is opt-in through either the flag or exact environment switch", () => {
  for (const result of [runCli({}, ["--strict"]), runCli({ SIGNAL_PREFLIGHT_STRICT: "1" })]) {
    assert.equal(result.status, 1);
    assert.match(result.output, /strict release configuration gate/);
    assert.match(result.output, /GITHUB_WEBHOOK_SECRET/);
  }
  const current = runCli({ SIGNAL_PREFLIGHT_STRICT: "0" });
  assert.equal(current.status, 0);
  assert.match(current.output, /currently supplied development variables/);
});

test("CLI returns failure for a supplied required placeholder without exposing values", () => {
  const result = runCli({
    SLACK_SIGNING_SECRET: "<synthetic-placeholder-do-not-print>",
    OPENROUTER_API_KEY: "synthetic-credential-do-not-print",
    UNRELATED_SECRET: "synthetic-unrelated-do-not-print",
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /SLACK_SIGNING_SECRET/);
  assert.doesNotMatch(result.output, /do-not-print|UNRELATED_SECRET/);
});

test("strict CLI success remains configuration evidence only", () => {
  const env = Object.fromEntries(FULL_CORE_VARIABLES.map((name) => [name, "synthetic-credential-do-not-print"]));
  const result = runCli(env, ["--strict"]);
  assert.equal(result.status, 0);
  assert.match(result.output, /16\/16 required names configured/);
  assert.match(result.output, /release acceptance: NOT RUN/);
  assert.doesNotMatch(result.output, /synthetic-credential-do-not-print/);
});
