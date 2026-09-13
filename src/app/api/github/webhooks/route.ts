import { after } from "next/server";
import { createDb } from "../../../../db/client";
import { acceptObserverEvent, resolveGitHubObserverTenant } from "../../../../db/repositories";
import { dispatchStoredOutboxJob } from "../../../../trigger/outbox";
import { createGitHubWebhookHandler } from "./handler";

export const runtime = "nodejs";
export const POST = createGitHubWebhookHandler({
  createDb, after, acceptObserverEvent, resolveGitHubObserverTenant, dispatchStoredOutboxJob,
  webhookSecret: () => process.env.GITHUB_WEBHOOK_SECRET ?? "",
});
