import { pathToFileURL } from "node:url";

export const FULL_CORE_VARIABLES = [
  "APP_BASE_URL",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "TRIGGER_PROJECT_REF",
  "TRIGGER_SECRET_KEY",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_LOGIN",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "CRON_SECRET",
  "SIGNAL_DASHBOARD_TENANT_ID",
  "SIGNAL_PILOT_CONFIG_PATH",
] as const;

// Historical bootstrap lists retained for import compatibility only. The default
// scope is derived from the names supplied to evaluatePreflight, never this list.
export const CURRENT_CORE_VARIABLES = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "TRIGGER_SECRET_KEY",
  "OPENROUTER_API_KEY",
] as const;

export const FULL_OPTIONAL_VARIABLES = [
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "ENABLE_INSPECTOR",
  "CPK_INTELLIGENCE_API_KEY",
  "EXA_API_KEY",
  "ENABLE_EXA",
  "AMBIGUOUS_API_KEY",
  "ENABLE_AMBIGUOUS",
  "SLACK_THREAD_READ_TOKEN",
  "TRIGGER_ACCESS_TOKEN",
] as const;

export const CURRENT_OPTIONAL_VARIABLES = [
  "AUTH0_DOMAIN",
  "CPK_INTELLIGENCE_API_KEY",
  "EXA_API_KEY",
] as const;

export type PreflightResult = {
  required: readonly string[];
  optional: readonly string[];
  missingRequired: string[];
  presentOptional: string[];
};

function isConfigured(value: string | undefined): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const normalized = value.trim();
  // Recognize explicit template markers, not credential formats or validity.
  // Keep provider values inside this predicate; results contain names only.
  return !/^(?:undefined|null|unset|placeholder|todo|tbd|(?:change|replace)[-_ ]?me|your[-_ ].+|x{3,})$/i.test(normalized)
    && !/<[^<>\r\n]+>/.test(normalized)
    && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(normalized);
}

export function evaluatePreflight(
  env: NodeJS.ProcessEnv,
  strict = false,
): PreflightResult {
  // An explicitly supplied blank/placeholder remains in scope and must be
  // corrected or unset. Absent future-provider names never block local work.
  const isSupplied = (name: string) => Object.hasOwn(env, name) && env[name] !== undefined;
  const required = strict ? FULL_CORE_VARIABLES : FULL_CORE_VARIABLES.filter(isSupplied);
  const optional = strict ? FULL_OPTIONAL_VARIABLES : FULL_OPTIONAL_VARIABLES.filter(isSupplied);
  const isPresent = (name: string) => isSupplied(name) && isConfigured(env[name]);

  return {
    required,
    optional,
    missingRequired: required.filter((name) => !isPresent(name)),
    presentOptional: optional.filter(isPresent),
  };
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const strict = process.argv.includes("--strict") || process.env.SIGNAL_PREFLIGHT_STRICT === "1";
  const result = evaluatePreflight(process.env, strict);

  console.log(
    `Preflight scope: ${strict ? "strict release configuration gate" : "currently supplied development variables"}.`,
  );
  console.log(
    `Preflight configuration: ${result.required.length - result.missingRequired.length}/${result.required.length} required names configured (non-empty, no recognized placeholder).`,
  );
  console.log(`Optional configuration: ${result.presentOptional.length}/${result.optional.length} names configured; optional features are not validated or enabled.`);
  console.log("No secret values are displayed.");
  console.log("Configuration check only. Live integrations, imported pilot mappings, permissions, and release acceptance: NOT RUN.");

  if (result.missingRequired.length > 0) {
    console.error(`Missing, blank, or placeholder required configuration names: ${result.missingRequired.join(", ")}`);
    process.exitCode = 1;
  }

  if (!strict) {
    if (result.required.length === 0) {
      console.log("No core configuration names supplied; local checks may proceed, but provider readiness is not established.");
    }
    console.log("Strict release configuration gate deferred; run `npm run preflight -- --strict` for the complete operator checklist.");
  }
}
