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

export function evaluatePreflight(
  env: NodeJS.ProcessEnv,
  strict = false,
): PreflightResult {
  const required = strict ? FULL_CORE_VARIABLES : CURRENT_CORE_VARIABLES;
  const optional = strict ? FULL_OPTIONAL_VARIABLES : CURRENT_OPTIONAL_VARIABLES;
  const isPresent = (name: string) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  };

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
    `Preflight scope: ${strict ? "full roadmap core gate" : "current development variables"}.`,
  );
  console.log(
    `Preflight configuration: ${result.required.length - result.missingRequired.length}/${result.required.length} required names present.`,
  );
  console.log(`Optional configuration: ${result.presentOptional.length}/${result.optional.length} names present.`);
  console.log("No secret values are displayed.");

  if (result.missingRequired.length > 0) {
    console.error(`Missing required configuration names: ${result.missingRequired.join(", ")}`);
    process.exitCode = 1;
  }

  if (!strict) {
    console.log("Full roadmap gate deferred; run `npm run preflight -- --strict` when remaining provider variables are available.");
  }
}
