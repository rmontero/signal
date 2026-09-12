import { createSlackApiClient } from "../../../../adapters/slack-api";
import { verifySlackRequestSignature } from "../../../../adapters/slack-standalone.mts";
import { createDb } from "../../../../db/client";
import { approveProposal, dismissProposal, isNamedApprover, loadProposalForApproval, loadSlackReview, recordSlackReview, resolveActiveSlackTenant } from "../../../../db/repositories";
import { handleSlackInteraction } from "../../../../services/slack-interactions";
import { dismissProposal as dismissProposalService, prepareProposalReview, recordProposalReview, submitProposalApproval } from "../../../../services/approve";
import { dispatchOutboxJob } from "../../../../trigger/dispatch";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifySlackRequestSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    rawBody,
    signature: request.headers.get("x-slack-signature") ?? "",
  });
  if (!verified.ok) return Response.json({ error: "Invalid request" }, { status: 401 });

  const { db, pool } = createDb();
  try {
    const slack = createSlackApiClient({ botToken: process.env.SLACK_BOT_TOKEN ?? "" });
    const result = await handleSlackInteraction(rawBody, {
      resolveTenantId: (input) => resolveActiveSlackTenant(db, input),
      prepareReview: (input) => prepareProposalReview(input, {
        now: () => new Date(),
        loadProposal: (proposalInput) => loadProposalForApproval(db, proposalInput),
        recordReview: (review) => recordSlackReview(db, review),
        loadReview: (reviewInput) => loadSlackReview(db, reviewInput),
        isNamedApprover: (approverInput) => isNamedApprover(db, approverInput),
        approve: (binding) => approveProposal(db, binding),
        dismiss: (dismissInput) => dismissProposal(db, dismissInput),
      }),
      openModal: (input) => slack.openModal(input),
      recordReview: (prepared, modalId) => recordProposalReview(prepared, modalId, {
        now: () => new Date(),
        loadProposal: (proposalInput) => loadProposalForApproval(db, proposalInput),
        recordReview: (review) => recordSlackReview(db, review),
        loadReview: (reviewInput) => loadSlackReview(db, reviewInput),
        isNamedApprover: (approverInput) => isNamedApprover(db, approverInput),
        approve: (binding) => approveProposal(db, binding),
        dismiss: (dismissInput) => dismissProposal(db, dismissInput),
      }),
      dismissReview: (input) => dismissProposalService(input, {
        now: () => new Date(),
        loadProposal: (proposalInput) => loadProposalForApproval(db, proposalInput),
        recordReview: (review) => recordSlackReview(db, review),
        loadReview: (reviewInput) => loadSlackReview(db, reviewInput),
        isNamedApprover: (approverInput) => isNamedApprover(db, approverInput),
        approve: (binding) => approveProposal(db, binding),
        dismiss: (dismissInput) => dismissProposal(db, dismissInput),
      }),
      submitApproval: async (input) => {
        const result = await submitProposalApproval(input, {
        now: () => new Date(),
        loadProposal: (proposalInput) => loadProposalForApproval(db, proposalInput),
        recordReview: (review) => recordSlackReview(db, review),
        loadReview: (reviewInput) => loadSlackReview(db, reviewInput),
        isNamedApprover: (approverInput) => isNamedApprover(db, approverInput),
        approve: (binding) => approveProposal(db, binding),
        dismiss: (dismissInput) => dismissProposal(db, dismissInput),
        });
        try { await dispatchOutboxJob({ tenantId: input.tenantId, jobId: result.jobId, taskId: "signal.execute-operation", schemaVersion: 1 }); } catch { /* durable outbox recovery owns redispatch */ }
        return result;
      },
    });
    return Response.json(result.body, { status: result.status });
  } catch {
    return Response.json({ error: "Interaction unavailable" }, { status: 503 });
  } finally {
    await pool.end();
  }
}
