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
      required: ["DATABASE_URL", "SIGNAL_DASHBOARD_TENANT_ID"],
      detail: "Tenant-scoped database reads are configured.",
    },
    {
      id: "slack",
      name: "Slack",
      category: "Sources" as const,
      required: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"],
      detail: "Signed Events API ingress and bot reads are configured.",
    },
    {
      id: "github",
      name: "GitHub",
      category: "Sources" as const,
      required: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
      detail: "GitHub App webhook verification and reads are configured.",
    },
    {
      id: "auth0",
      name: "Auth0",
      category: "Access" as const,
      required: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"],
      detail: "Application and session configuration are present.",
    },
    {
      id: "trigger",
      name: "Trigger.dev",
      category: "Runtime" as const,
      required: ["TRIGGER_PROJECT_REF", "TRIGGER_SECRET_KEY"],
      detail: "Background task execution configuration is present.",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      category: "Intelligence" as const,
      required: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
      detail: "The selected Luna model route is configured.",
    },
    {
      id: "upstash",
      name: "Upstash",
      category: "Optional" as const,
      required: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
      detail: "Optional Redis configuration is present; it is not required for the MVP observer.",
    },
  ];

  return statuses.map((connector) => ({
    ...connector,
    status: readiness(env, connector.required),
  }));
}
