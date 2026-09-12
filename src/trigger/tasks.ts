import { createAppAuth } from "@octokit/auth-app";
import { AbortTaskRunError, logger, schedules, schemaTask } from "@trigger.dev/sdk";
import { createGitHubReadClient } from "../adapters/github-read";
import { createGitHubWriteClient } from "../adapters/github-write-standalone.mts";
import { createOpenRouterClient } from "../adapters/openrouter";
import { createSlackApiClient } from "../adapters/slack-api";
import { createSlackRepliesClient } from "../adapters/slack-web-api-standalone.mts";
import { fetchCompleteSlackThread } from "../adapters/slack-standalone.mts";
import { createDb } from "../db/client";
import { loadApprovedProposalForExecution, loadIdentityMappings, loadInboxContext, loadNotificationContext, loadObservedEvent, loadOutboxJob, loadRepositoryInstallation, loadUnknownOperation, persistAnalyzedProposal, recordFailedResult, recordReconciledResult, recordStaleResult, recordSuccessfulResult, recordUnresolvedOperation, recordUnknownResult, setNotificationMessageTs, transitionSendingToUnknown } from "../db/repositories";
import { TaskInputSchema } from "../domain/contracts";
import { analyzeThread } from "../services/analyze";
import { executeApprovedProposal } from "../services/execute";
import { reconcileUnknownOperation } from "../services/reconcile";
import { deliverResultNotification } from "../services/notify";
import { renderProposalCard } from "../services/proposal-card";

const taskInput = TaskInputSchema;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AbortTaskRunError(`${name} is not configured`);
  return value;
}

function slackPermalink(channelId: string, ts: string): string {
  return `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

async function githubClients(installationId: string) {
  const appId = Number(requiredEnv("GITHUB_APP_ID"));
  const privateKey = requiredEnv("GITHUB_APP_PRIVATE_KEY").replaceAll("\\n", "\n");
  if (!Number.isSafeInteger(appId) || appId < 1) throw new AbortTaskRunError("GITHUB_APP_ID is invalid");
  const auth = createAppAuth({ appId, privateKey });
  const token = await auth({ type: "installation", installationId });
  return {
    read: createGitHubReadClient({ token: token.token }),
    write: createGitHubWriteClient({ token: token.token }),
  };
}

export const observeEventTask = schemaTask({
  id: "signal.observe-event",
  schema: taskInput,
  retry: { maxAttempts: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 10_000, factor: 2, randomize: true },
  run: async (payload) => {
    const { db, pool } = createDb();
    try {
      const job = await loadOutboxJob(db, { tenantId: payload.tenantId, jobId: payload.jobId, taskId: "signal.observe-event" });
      if (!job?.observerEventId) throw new AbortTaskRunError("observer job is unavailable");
      const event = await loadObservedEvent(db, { tenantId: payload.tenantId, eventId: job.observerEventId });
      if (!event) throw new AbortTaskRunError("observer event is unavailable");
      // Passive observation deliberately records no proposal and performs no GitHub write.
      logger.info("Signal observer event accepted", { tenantId: payload.tenantId, eventId: event.id, source: event.source, eventType: event.eventType });
      return { status: "observed" as const, eventId: event.id };
    } finally { await pool.end(); }
  },
});

export const analyzeThreadTask = schemaTask({
  id: "signal.analyze-thread",
  schema: taskInput,
  retry: { maxAttempts: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 10_000, factor: 2, randomize: true },
  run: async (payload) => {
    const botToken = requiredEnv("SLACK_BOT_TOKEN");
    const { db, pool } = createDb();
    try {
      const job = await loadOutboxJob(db, { tenantId: payload.tenantId, jobId: payload.jobId, taskId: "signal.analyze-thread" });
      if (!job?.inboxId) throw new AbortTaskRunError("analysis job is unavailable");
      const context = await loadInboxContext(db, { tenantId: payload.tenantId, inboxId: job.inboxId });
      if (!context) throw new AbortTaskRunError("analysis context is unavailable");
      const replies = createSlackRepliesClient({ botToken });
      const complete = await fetchCompleteSlackThread(replies, { channelId: context.channelId, threadTs: context.threadTs, maxMessages: 50, pageSize: 100 });
      const sourceMessages = complete.sourceMessages.filter((message) => typeof message.text === "string" && message.text.trim() && typeof message.user === "string").map((message) => ({ ts: message.ts, user: message.user ?? null, text: message.text ?? "", permalink: slackPermalink(context.channelId, message.ts), isBot: Boolean(message.bot_id || message.subtype === "bot_message") }));
      if (sourceMessages.length === 0) throw new AbortTaskRunError("thread has no eligible human messages");
      const model = createOpenRouterClient({ apiKey: requiredEnv("OPENROUTER_API_KEY"), model: requiredEnv("OPENROUTER_MODEL") });
      const installationId = await loadRepositoryInstallation(db, { tenantId: payload.tenantId, repositoryId: context.repository.repoId });
      if (!installationId) throw new AbortTaskRunError("repository installation is unavailable");
      const clients = await githubClients(installationId);
      const result = await analyzeThread({
        tenantId: payload.tenantId, threadId: context.threadId, channelId: context.channelId, threadTs: context.threadTs, version: 1,
        invocationText: sourceMessages.find((message) => message.ts === context.messageTs)?.text ?? "Please analyze this Signal thread.",
        repository: context.repository, sourceMessages, identityMappings: await loadIdentityMappings(db, payload.tenantId),
      }, {
        model, github: clients.read,
        persistProposal: (input) => persistAnalyzedProposal(db, { tenantId: input.tenantId, threadId: input.threadId, version: input.version, operationId: input.operationId, mutation: input.mutation, actionFingerprint: input.actionFingerprint, expiresAt: input.expiresAt, snapshot: input.snapshot }),
      });
      const card = renderProposalCard({ proposalId: result.persisted.proposalId, version: 1, mutation: result.mutation, analysis: result.analysis, analysisDurationMs: 0, executable: true });
      const message = await createSlackApiClient({ botToken }).postMessage({ channelId: context.channelId, threadTs: context.threadTs, text: "Signal proposal ready for review", blocks: card.blocks });
      await setNotificationMessageTs(db, { tenantId: payload.tenantId, threadId: context.threadId, messageTs: message.messageTs });
      return { state: "proposal_ready" as const, proposalId: result.persisted.proposalId };
    } finally { await pool.end(); }
  },
});

export const executeOperationTask = schemaTask({
  id: "signal.execute-operation",
  schema: taskInput,
  run: async (payload) => {
    const { db, pool } = createDb();
    try {
      const job = await loadOutboxJob(db, { tenantId: payload.tenantId, jobId: payload.jobId, taskId: "signal.execute-operation" });
      if (!job?.operationId) throw new AbortTaskRunError("execution job is unavailable");
      const proposal = await loadApprovedProposalForExecution(db, { tenantId: payload.tenantId, operationId: job.operationId });
      if (!proposal) throw new AbortTaskRunError("approved operation is unavailable");
      const installationId = await loadRepositoryInstallation(db, { tenantId: payload.tenantId, repositoryId: proposal.mutation.repoId });
      if (!installationId) throw new AbortTaskRunError("repository installation is unavailable");
      const clients = await githubClients(installationId);
      const result = await executeApprovedProposal({ tenantId: payload.tenantId, operationId: job.operationId, attemptId: payload.jobId }, {
        now: () => new Date(), loadApprovedProposal: async () => proposal,
        claimMutation: (input) => import("../db/repositories").then(({ claimMutation }) => claimMutation(db, input)),
        github: clients.write, githubRead: clients.read,
        recordSuccess: (input) => recordSuccessfulResult(db, input), recordFailure: (input) => recordFailedResult(db, input), recordUnknown: (input) => recordUnknownResult(db, input), recordStale: (input) => recordStaleResult(db, input),
      });
      return { state: result.state };
    } finally { await pool.end(); }
  },
});

export const reconcileOperationTask = schemaTask({
  id: "signal.reconcile-operation",
  schema: taskInput,
  retry: { maxAttempts: 3, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, factor: 2, randomize: true },
  run: async (payload) => {
    const expectedAuthorLogin = requiredEnv("GITHUB_APP_LOGIN");
    const { db, pool } = createDb();
    try {
      const job = await loadOutboxJob(db, { tenantId: payload.tenantId, jobId: payload.jobId, taskId: "signal.reconcile-operation" });
      if (!job?.operationId) throw new AbortTaskRunError("reconciliation job is unavailable");
      const operation = await loadUnknownOperation(db, { tenantId: payload.tenantId, operationId: job.operationId, expectedAuthorLogin });
      if (!operation) throw new AbortTaskRunError("uncertain operation is unavailable");
      const installationId = await loadRepositoryInstallation(db, { tenantId: payload.tenantId, repositoryId: operation.mutation.repoId });
      if (!installationId) throw new AbortTaskRunError("repository installation is unavailable");
      const clients = await githubClients(installationId);
      const result = await reconcileUnknownOperation({ tenantId: payload.tenantId, operationId: job.operationId }, {
        now: () => new Date(), loadOperation: async () => operation, isOwningAttemptTerminal: async () => true,
        transitionSendingToUnknown: (input) => transitionSendingToUnknown(db, input), listIssues: (input) => clients.read.listIssues?.(input) ?? Promise.reject(new Error("issue reconciliation unavailable")), listComments: (input) => clients.read.listComments?.(input) ?? Promise.reject(new Error("comment reconciliation unavailable")),
        recordSuccess: (input) => recordReconciledResult(db, input), recordUnresolved: (input) => recordUnresolvedOperation(db, input),
      });
      return { state: result.state, reason: result.state === "UNKNOWN" ? result.reason : "reconciled" };
    } finally { await pool.end(); }
  },
});

export const notifySlackTask = schemaTask({
  id: "signal.notify-slack",
  schema: taskInput,
  run: async (payload) => {
    const { db, pool } = createDb();
    try {
      const job = await loadOutboxJob(db, { tenantId: payload.tenantId, jobId: payload.jobId, taskId: "signal.notify-slack" });
      if (!job?.operationId) throw new AbortTaskRunError("notification job is unavailable");
      const context = await loadNotificationContext(db, { tenantId: payload.tenantId, operationId: job.operationId });
      if (!context) throw new AbortTaskRunError("notification context is unavailable");
      await deliverResultNotification({ channelId: context.channelId, messageTs: context.messageTs, text: "" }, context, createSlackApiClient({ botToken: requiredEnv("SLACK_BOT_TOKEN") }));
      return { state: "notified" as const };
    } finally { await pool.end(); }
  },
});

export const recoverTask = schedules.task({ id: "signal.recover", cron: { pattern: "* * * * *", timezone: "UTC" }, run: async () => ({ status: "scheduled" as const }) });
export const cleanupTask = schedules.task({ id: "signal.cleanup", cron: { pattern: "0 * * * *", timezone: "UTC" }, run: async () => ({ status: "scheduled" as const }) });
