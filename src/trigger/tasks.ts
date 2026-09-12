import { createAppAuth } from "@octokit/auth-app";
import { AbortTaskRunError, logger, schedules, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createGitHubReadClient } from "../adapters/github-read";
import { createGitHubWriteClient } from "../adapters/github-write-standalone.mts";
import { createOpenRouterClient } from "../adapters/openrouter";
import { createSlackApiClient } from "../adapters/slack-api";
import { confirmTerminalTriggerRun } from "../adapters/trigger-run-status";
import { createSlackRepliesClient } from "../adapters/slack-web-api-standalone.mts";
import { fetchCompleteSlackThread } from "../adapters/slack-standalone.mts";
import { createDb } from "../db/client";
import { cleanupRetention, loadApprovedProposalForExecution, loadIdentityMappings, loadInboxContext, loadMappedRepository, loadNotificationContext, loadObservedEvent, loadOutboxJob, loadOwningExecutionRun, loadRepositoryInstallation, loadUnknownOperation, persistAnalyzedProposal, recordFailedResult, recordObserverClassification, recordReconciledResult, recordStaleResult, recordSuccessfulResult, recordUnresolvedOperation, recordUnknownResult, setNotificationMessageTs, transitionSendingToUnknown } from "../db/repositories";
import { recoverOutbox } from "../services/recover-outbox";
import { recordOutboxExecutionOwner } from "../db/repositories";
import { TaskInputSchema } from "../domain/contracts";
import { analyzeThread } from "../services/analyze";
import { executeApprovedProposal } from "../services/execute";
import { reconcileUnknownOperation } from "../services/reconcile";
import { deliverResultNotification } from "../services/notify";
import { renderProposalCard } from "../services/proposal-card";

const taskInput = TaskInputSchema;
const ObserverClassificationSchema = z.object({ meaningful: z.boolean(), reason: z.string().trim().min(1).max(240), evidenceMessageTs: z.array(z.string().trim().min(1)).max(5) }).strict();
const OBSERVER_CLASSIFICATION_JSON_SCHEMA = { type: "object", additionalProperties: false, properties: { meaningful: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 240 }, evidenceMessageTs: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 } } }, required: ["meaningful", "reason", "evidenceMessageTs"] } as const;

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
      const model = createOpenRouterClient({ apiKey: requiredEnv("OPENROUTER_API_KEY"), model: requiredEnv("OPENROUTER_MODEL") });
      let classification: z.infer<typeof ObserverClassificationSchema>;
      let evidenceRefs: unknown[] = [];
      if (event.source === "slack") {
        if (!event.channelId || !event.threadTs) throw new AbortTaskRunError("Slack observer coordinates are incomplete");
        const complete = await fetchCompleteSlackThread(createSlackRepliesClient({ botToken: requiredEnv("SLACK_BOT_TOKEN") }), { channelId: event.channelId, threadTs: event.threadTs, maxMessages: 50, pageSize: 100 });
        const messages = complete.sourceMessages.filter((message) => typeof message.text === "string" && message.text.trim()).map((message) => ({ ts: message.ts, text: message.text ?? "", permalink: slackPermalink(event.channelId!, message.ts) }));
        const obviousNoise = messages.length === 0 || !messages.some((message) => /\b(decision|decided|task|todo|blocker|blocked|deadline|ship|release|issue|follow[- ]?up|owner)\b|https:\/\/github\.com\//i.test(message.text));
        if (obviousNoise) classification = { meaningful: false, reason: "Deterministic filter found no action-bearing signal.", evidenceMessageTs: [] };
        else classification = ObserverClassificationSchema.parse(await model.complete({ system: "You are Signal's passive observer classifier. Return only strict JSON. Never propose or authorize an action.", user: JSON.stringify({ task: "Separate meaningful workplace signal from noise.", messages, rules: ["Use only supplied messages.", "Meaningful means a decision, task, blocker, owner, deadline, release, or GitHub-linked question.", "Return at most five evidence message timestamps."] }), schemaName: "signal_observer_classification", schema: OBSERVER_CLASSIFICATION_JSON_SCHEMA }));
        const allowed = new Set(messages.map((message) => message.ts));
        const validEvidence = classification.evidenceMessageTs.filter((ts) => allowed.has(ts));
        evidenceRefs = messages.filter((message) => validEvidence.includes(message.ts)).map((message) => ({ messageTs: message.ts, permalink: message.permalink }));
      } else {
        if (!event.repositoryOwner || !event.repositoryName || !event.pullRequestNumber) throw new AbortTaskRunError("GitHub observer coordinates are incomplete");
        const installationId = await loadRepositoryInstallation(db, { tenantId: payload.tenantId, repositoryId: event.repositoryId ?? "" });
        if (!installationId) throw new AbortTaskRunError("repository installation is unavailable");
        const clients = await githubClients(installationId);
        const pr = await clients.read.getIssue({ owner: event.repositoryOwner, repo: event.repositoryName, issueNumber: event.pullRequestNumber });
        classification = ObserverClassificationSchema.parse(await model.complete({ system: "You are Signal's passive observer classifier. Return only strict JSON. Never propose or authorize an action.", user: JSON.stringify({ task: "Classify whether this pull-request event has meaningful signal for an executive summary.", pullRequest: { title: pr.title, url: pr.htmlUrl, eventType: event.eventType }, rules: ["Meaningful means a review, blocker, delivery risk, or material state change.", "Do not invent details."] }), schemaName: "signal_observer_classification", schema: OBSERVER_CLASSIFICATION_JSON_SCHEMA }));
        evidenceRefs = [{ repositoryId: event.repositoryId, pullRequestNumber: event.pullRequestNumber, url: pr.htmlUrl }];
      }
      const state = classification.meaningful ? "SIGNAL" : "NOISE";
      await recordObserverClassification(db, { tenantId: payload.tenantId, eventId: event.id, state, reason: classification.reason, evidenceRefs });
      logger.info("Signal observer classification stored", { tenantId: payload.tenantId, eventId: event.id, state, evidenceCount: evidenceRefs.length });
      return { status: state.toLowerCase() as "signal" | "noise", eventId: event.id };
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
  retry: { maxAttempts: 1 },
  run: async (payload, { ctx }) => {
    const { db, pool } = createDb();
    try {
      const job = await loadOutboxJob(db, { tenantId: payload.tenantId, jobId: payload.jobId, taskId: "signal.execute-operation" });
      if (!job?.operationId) throw new AbortTaskRunError("execution job is unavailable");
      if (!await recordOutboxExecutionOwner(db, { tenantId: payload.tenantId, jobId: payload.jobId, runId: ctx.run.id })) throw new AbortTaskRunError("execution owner binding is unavailable");
      const proposal = await loadApprovedProposalForExecution(db, { tenantId: payload.tenantId, operationId: job.operationId });
      if (!proposal) throw new AbortTaskRunError("approved operation is unavailable");
      const installationId = await loadRepositoryInstallation(db, { tenantId: payload.tenantId, repositoryId: proposal.mutation.repoId });
      if (!installationId) throw new AbortTaskRunError("repository installation is unavailable");
      const clients = await githubClients(installationId);
      const result = await executeApprovedProposal({ tenantId: payload.tenantId, operationId: job.operationId, attemptId: ctx.run.id }, {
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
  retry: { maxAttempts: 3, minTimeoutInMs: 30_000, maxTimeoutInMs: 60_000, factor: 2, randomize: false },
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
      const signal = AbortSignal.timeout(30_000);
      const result = await reconcileUnknownOperation({ tenantId: payload.tenantId, operationId: job.operationId }, {
        now: () => new Date(), loadOperation: async () => operation,
        isOwningAttemptTerminal: async (input) => {
          const owner = await loadOwningExecutionRun(db, input);
          return owner ? confirmTerminalTriggerRun({ ...owner, tenantId: input.tenantId }) : false;
        },
        getRepository: async (input) => {
          const mapped = await loadMappedRepository(db, input);
          if (!mapped) return null;
          const actual = await clients.read.getRepository?.({ owner: input.owner, repo: input.repo, signal });
          return actual?.id === mapped.id ? actual : null;
        },
        transitionSendingToUnknown: (input) => transitionSendingToUnknown(db, input), listIssues: (input) => clients.read.listIssues?.({ ...input, signal }) ?? Promise.reject(new Error("issue reconciliation unavailable")), listComments: (input) => clients.read.listComments?.({ ...input, signal }) ?? Promise.reject(new Error("comment reconciliation unavailable")),
        recordSuccess: (input) => recordReconciledResult(db, input), recordUnresolved: (input) => recordUnresolvedOperation(db, input),
      });
      if (result.state === "UNKNOWN" && ["active_attempt", "unavailable"].includes(result.reason)) throw new Error("reconciliation_waiting_for_evidence");
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

export const recoverTask = schedules.task({ id: "signal.recover", cron: { pattern: "* * * * *", timezone: "UTC" }, run: async () => {
  const { db, pool } = createDb();
  try {
    return { status: "recovered" as const, ...(await recoverOutbox(db)) };
  } finally { await pool.end(); }
} });
export const cleanupTask = schedules.task({ id: "signal.cleanup", cron: { pattern: "0 * * * *", timezone: "UTC" }, run: async () => {
  const { db, pool } = createDb();
  try { return { status: "cleaned" as const, ...(await cleanupRetention(db)) }; }
  finally { await pool.end(); }
} });
