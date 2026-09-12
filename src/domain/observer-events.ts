import { createHash } from "node:crypto";

export type ObserverSource = "slack" | "github";

type ObserverEventBase = {
  tenantId: string;
  source: ObserverSource;
  providerEventId: string;
  eventType: string;
  actorId?: string | null;
  rawBody: string;
};

export type SlackObserverEventInput = ObserverEventBase & {
  source: "slack";
  channelId: string;
  threadTs: string;
  messageTs: string;
};

export type GitHubObserverEventInput = ObserverEventBase & {
  source: "github";
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  installationId: string;
  pullRequestNumber: number;
};

export type CreateObserverEventInput = SlackObserverEventInput | GitHubObserverEventInput;

export type ObserverEventInput = {
  tenantId: string;
  source: ObserverSource;
  providerEventId: string;
  eventType: string;
  channelId: string | null;
  threadTs: string | null;
  messageTs: string | null;
  actorId: string | null;
  repositoryId: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  installationId: string | null;
  pullRequestNumber: number | null;
  payloadHash: string;
};

function hashRawBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export function createObserverEventInput(input: CreateObserverEventInput): ObserverEventInput {
  if (!input.tenantId.trim() || !input.providerEventId.trim() || !input.eventType.trim()) {
    throw new Error("Observer event identity is required");
  }
  if (typeof input.rawBody !== "string") throw new Error("Observer event body is required");

  const common = {
    tenantId: input.tenantId,
    source: input.source,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    channelId: null,
    threadTs: null,
    messageTs: null,
    actorId: input.actorId ?? null,
    repositoryId: null,
    repositoryOwner: null,
    repositoryName: null,
    installationId: null,
    pullRequestNumber: null,
    payloadHash: hashRawBody(input.rawBody),
  } satisfies ObserverEventInput;

  if (input.source === "slack") {
    return { ...common, channelId: input.channelId, threadTs: input.threadTs, messageTs: input.messageTs };
  }

  return {
    ...common,
    repositoryId: input.repositoryId,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    installationId: input.installationId,
    pullRequestNumber: input.pullRequestNumber,
  };
}
