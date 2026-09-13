import type { createSlackApiClient } from "../../../../adapters/slack-api";
import type * as repositories from "../../../../db/repositories";
import { handleSlackInteraction } from "../../../../services/slack-interactions";
import { dismissProposal, prepareProposalReview, recordProposalReview, submitProposalApproval, type ApprovalDependencies } from "../../../../services/approve";
import { finishIngress, IngressError, ingressError, readSignedBody, RequestDeadline, type Connection, type IngressDependencies, type StoredJob } from "../../_lib/ingress";

export interface SlackInteractionsDependencies extends IngressDependencies {
  signingSecret: () => string;
  botToken: () => string;
  createSlackApiClient: typeof createSlackApiClient;
  repository: Pick<typeof repositories, "approveProposal" | "dismissProposal" | "isNamedApprover" | "loadProposalForApproval" | "loadSlackReview" | "recordSlackReview" | "resolveActiveSlackTenant">;
}

export function createSlackInteractionsHandler(dependencies: SlackInteractionsDependencies) {
  return async (request: Request): Promise<Response> => {
    const deadline = new RequestDeadline(dependencies.timeoutMs);
    let connection: Connection | undefined;
    let job: StoredJob | undefined;
    const database = () => {
      deadline.check();
      connection ??= dependencies.createDb();
      return connection.db;
    };
    try {
      const rawBody = await readSignedBody(request, { provider: "slack", secret: dependencies.signingSecret(), deadline, maxBytes: 64 * 1024 });
      const repo = dependencies.repository;
      const approval: ApprovalDependencies = {
        now: () => new Date(),
        loadProposal: (input) => deadline.run(() => repo.loadProposalForApproval(database(), input)),
        recordReview: (input) => deadline.run(() => repo.recordSlackReview(database(), input)),
        loadReview: (input) => deadline.run(() => repo.loadSlackReview(database(), input)),
        isNamedApprover: (input) => deadline.run(() => repo.isNamedApprover(database(), input)),
        // Forward the exact canonical binding AND modalId; the repository owns the transaction.
        approve: (input) => deadline.run(() => repo.approveProposal(database(), input)),
        dismiss: (input) => deadline.run(() => repo.dismissProposal(database(), input)),
      };
      const slack = () => dependencies.createSlackApiClient({ botToken: dependencies.botToken(), signal: deadline.signal });
      const result = await deadline.run(() => handleSlackInteraction(rawBody, {
        resolveTenantId: (input) => deadline.run(async () => {
          const tenantId = await repo.resolveActiveSlackTenant(database(), input);
          return tenantId?.trim() && tenantId === tenantId.trim() ? tenantId : null;
        }),
        prepareReview: (input) => prepareProposalReview(input, approval),
        openModal: (input) => deadline.run(() => slack().openModal(input)),
        openNotice: (input) => deadline.run(async () => { await slack().openModal(input); }),
        recordReview: (prepared, modalId) => recordProposalReview(prepared, modalId, approval),
        dismissReview: (input) => dismissProposal(input, approval),
        submitApproval: async (input) => {
          const result = await submitProposalApproval(input, approval);
          deadline.check();
          if (!result.approvalId || !result.jobId) throw new IngressError(503);
          job = { tenantId: input.tenantId, jobId: result.jobId, taskId: "signal.execute-operation", schemaVersion: 1 };
          return result;
        },
      }));
      if (result.status >= 500) throw new IngressError(503);
      return Response.json(result.body, { status: result.status });
    } catch (error) { return ingressError(error, "slack", "Interaction unavailable"); }
    finally {
      deadline.close();
      finishIngress(dependencies, connection, job);
    }
  };
}
