import { after } from "next/server";
import { createSlackApiClient } from "../../../../adapters/slack-api";
import { createDb } from "../../../../db/client";
import { approveProposal, dismissProposal, isNamedApprover, loadProposalForApproval, loadSlackReview, recordSlackReview, resolveActiveSlackTenant } from "../../../../db/repositories";
import { dispatchStoredOutboxJob } from "../../../../trigger/outbox";
import { createSlackInteractionsHandler } from "./handler";

export const runtime = "nodejs";
export const POST = createSlackInteractionsHandler({
  createDb, after, createSlackApiClient, dispatchStoredOutboxJob,
  signingSecret: () => process.env.SLACK_SIGNING_SECRET ?? "",
  botToken: () => process.env.SLACK_BOT_TOKEN ?? "",
  repository: { approveProposal, dismissProposal, isNamedApprover, loadProposalForApproval, loadSlackReview, recordSlackReview, resolveActiveSlackTenant },
});
