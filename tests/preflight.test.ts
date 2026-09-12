import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_CORE_VARIABLES,
  CURRENT_OPTIONAL_VARIABLES,
  FULL_CORE_VARIABLES,
  evaluatePreflight,
} from "../scripts/preflight.ts";

test("default preflight evaluates only the variables in the current development scope", () => {
  const result = evaluatePreflight(
    {
      DATABASE_URL: "postgres://pooled",
      DATABASE_URL_UNPOOLED: "postgres://direct",
      TRIGGER_SECRET_KEY: "tr_dev",
      OPENROUTER_API_KEY: "or_key",
      AUTH0_DOMAIN: "example.us.auth0.com",
      CPK_INTELLIGENCE_API_KEY: "cpk_key",
      EXA_API_KEY: "exa_key",
      SLACK_BOT_TOKEN: "not part of current scope",
    },
    false,
  );

  assert.deepEqual(result.required, CURRENT_CORE_VARIABLES);
  assert.deepEqual(result.optional, CURRENT_OPTIONAL_VARIABLES);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.presentOptional, CURRENT_OPTIONAL_VARIABLES);
});

test("strict preflight keeps the complete roadmap gate available", () => {
  const result = evaluatePreflight(
    {
      DATABASE_URL: "postgres://pooled",
      DATABASE_URL_UNPOOLED: "postgres://direct",
      TRIGGER_SECRET_KEY: "tr_dev",
      OPENROUTER_API_KEY: "or_key",
    },
    true,
  );

  assert.deepEqual(result.required, FULL_CORE_VARIABLES);
  assert.ok(result.missingRequired.includes("SLACK_BOT_TOKEN"));
  assert.ok(result.missingRequired.includes("GITHUB_APP_ID"));
});
