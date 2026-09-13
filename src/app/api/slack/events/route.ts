import { after } from "next/server";
import { acceptMention, acceptObserverEvent, resolveSlackObserverTenant } from "../../../../db/repositories";
import { createDb } from "../../../../db/client";
import { dispatchStoredOutboxJob } from "../../../../trigger/outbox";
import { createSlackEventsHandler } from "./handler";

export const runtime = "nodejs";
export const POST = createSlackEventsHandler({
  createDb, after, acceptMention, acceptObserverEvent, resolveSlackObserverTenant, dispatchStoredOutboxJob,
  signingSecret: () => process.env.SLACK_SIGNING_SECRET ?? "",
});
