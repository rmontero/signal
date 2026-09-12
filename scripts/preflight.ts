const required = [
  "APP_BASE_URL",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "TRIGGER_PROJECT_REF",
  "TRIGGER_SECRET_KEY",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "CRON_SECRET",
  "SIGNAL_PILOT_CONFIG_PATH",
] as const;

const optional = [
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

const present = (name: string) => {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
};

const missingRequired = required.filter((name) => !present(name));
const presentOptional = optional.filter(present);

console.log(`Preflight configuration: ${required.length - missingRequired.length}/${required.length} required names present.`);
console.log(`Optional configuration: ${presentOptional.length}/${optional.length} names present.`);
console.log("No secret values are displayed.");

if (missingRequired.length > 0) {
  console.error(`Missing required configuration names: ${missingRequired.join(", ")}`);
  process.exitCode = 1;
}
