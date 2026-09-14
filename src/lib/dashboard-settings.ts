export const dashboardSections = [
  "overview",
  "conversations",
  "decisions",
  "activity",
  "sources",
  "settings",
] as const;

export type DashboardSection = (typeof dashboardSections)[number];

const sectionSet = new Set<string>(dashboardSections);

export function dashboardSectionFromHash(hash: string): DashboardSection {
  const section = hash.replace(/^#/, "");
  return sectionSet.has(section) ? (section as DashboardSection) : "overview";
}

export type ConnectorEnvironment = Partial<Record<
  | "DATABASE_URL"
  | "SIGNAL_DASHBOARD_TENANT_ID"
  | "SLACK_SIGNING_SECRET"
  | "SLACK_BOT_TOKEN"
  | "GITHUB_APP_ID"
  | "GITHUB_APP_PRIVATE_KEY"
  | "GITHUB_WEBHOOK_SECRET"
  | "GITHUB_APP_LOGIN"
  | "AUTH0_DOMAIN"
  | "AUTH0_CLIENT_ID"
  | "AUTH0_CLIENT_SECRET"
  | "AUTH0_SECRET"
  | "TRIGGER_PROJECT_REF"
  | "TRIGGER_SECRET_KEY"
  | "OPENROUTER_API_KEY"
  | "OPENROUTER_MODEL"
  | "UPSTASH_REDIS_REST_URL"
  | "UPSTASH_REDIS_REST_TOKEN",
  string | undefined
>>;

// Preserve the existing API: "ready" means required names are present, not a live connection.
export type ConnectorStatus = "ready" | "needs-config" | "not-configured";

export type ConnectorSummary = {
  id: string;
  name: string;
  category: "Data" | "Sources" | "Access" | "Runtime" | "Intelligence" | "Optional";
  status: ConnectorStatus;
  detail: string;
  required: string[];
};

function readiness(env: ConnectorEnvironment, required: string[]): ConnectorStatus {
  const present = required.filter((name) => Boolean(env[name as keyof ConnectorEnvironment]?.trim()));
  if (present.length === required.length) return "ready";
  return present.length ? "needs-config" : "not-configured";
}

export function getConnectorStatuses(env: ConnectorEnvironment): ConnectorSummary[] {
  const statuses = [
    {
      id: "neon",
      name: "Neon",
      category: "Data" as const,
      // Preserve the operator's legacy pilot setup check, not dashboard authority.
      required: ["DATABASE_URL", "SIGNAL_DASHBOARD_TENANT_ID"],
      detail: "Legacy operator pilot setup only: import the allowed channel/repository mappings. Authenticated monitoring uses server-resolved membership and does not require this legacy tenant selector. A successful dashboard refresh verifies only that database read.",
    },
    {
      id: "slack",
      name: "Slack",
      category: "Sources" as const,
      required: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"],
      detail: "Register the signed Events API endpoint, allowlist non-shared pilot channels and verify a real delivery. Credential presence does not verify delivery or bot access.",
    },
    {
      id: "github",
      name: "GitHub",
      category: "Sources" as const,
      required: ["GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_LOGIN"],
      detail: "Register the signed pull-request webhook and map the selected GitHub App installation/repository. Credential presence does not verify delivery or repository access.",
    },
    {
      id: "auth0",
      name: "Auth0",
      category: "Access" as const,
      // Legacy inspector setup presence only; this is not session readiness.
      required: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"],
      detail: "These legacy inspector configuration checks do not verify authentication. Auth0 sign-in requires AUTH0_BASE_URL, AUTH0_ISSUER_BASE_URL, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET and AUTH0_SECRET on the server, plus an active tenant membership for monitoring. Signing in does not connect Slack or GitHub providers or authorize GitHub writes. The optional proposal inspector is disabled.",
    },
    {
      id: "trigger",
      name: "Trigger.dev",
      category: "Runtime" as const,
      required: ["TRIGGER_PROJECT_REF", "TRIGGER_SECRET_KEY"],
      detail: "Deploy the current tasks and configure the worker environment. A verified task run is required; web-server credentials do not prove a worker is running.",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      category: "Intelligence" as const,
      required: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
      detail: "Configure the selected OpenAI model in the worker environment and verify an analysis run. Credentials do not prove inference succeeded.",
    },
  ];

  return statuses.map((connector) => {
    const status = readiness(env, connector.required);
    const missing = connector.required.filter((name) => !env[name as keyof ConnectorEnvironment]?.trim());
    return {
      ...connector,
      status,
      detail: `${missing.length ? `Missing server configuration: ${missing.join(", ")}.` : "Required names are present on this web server; live verification is pending."} ${connector.detail}`,
    };
  });
}
