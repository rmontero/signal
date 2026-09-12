import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis } from "../src/domain/contracts";
import { AnalysisError, analyzeThread, type AnalysisContext, type AnalysisDependencies } from "../src/services/analyze";

const sourceMessages = [
  { ts: "1710000000.000001", user: "U123", text: "We should track the migration and ship it this week.", permalink: "https://slack.example/archives/C123/p1710000000000001" },
  { ts: "1710000000.000002", user: "U456", text: "I will verify the deployment after the issue is opened.", permalink: "https://slack.example/archives/C123/p1710000000000002" },
];

function facts(): { analysis: Analysis; searchQueries: string[] } {
  return {
    analysis: {
      decisions: [{ text: "Track the migration", evidence: [{ messageTs: sourceMessages[0].ts, permalink: sourceMessages[0].permalink }] }],
      tasks: [{ text: "Verify deployment", ownerSlackId: "U456", deadlineText: "this week", evidence: [{ messageTs: sourceMessages[1].ts, permalink: sourceMessages[1].permalink }] }],
      blockers: [],
      uncertainties: [],
    },
    searchQueries: ["migration"],
  };
}

function context(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    tenantId: "tenant-1",
    threadId: "thread-1",
    channelId: "C123",
    threadTs: sourceMessages[0].ts,
    version: 1,
    invocationText: "Please turn this into a GitHub issue",
    repository: { repoId: "repo-1", owner: "acme", repo: "signal" },
    sourceMessages,
    identityMappings: { U456: "octocat" },
    now: new Date("2026-09-12T12:00:00.000Z"),
    ...overrides,
  };
}

function dependencies(overrides: Partial<AnalysisDependencies> = {}): AnalysisDependencies {
  return {
    model: {
      modelVersion: "openai/gpt-5-mini",
      complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? facts() : {
        title: "Track migration",
        body: `Evidence: ${sourceMessages[0].permalink}`,
        assigneeSlackId: "U456",
        relatedCandidateIds: [],
      },
    },
    github: {
      search: async () => [],
      getIssue: async () => {
        throw new Error("unexpected target lookup");
      },
    },
    persistProposal: async (input) => ({
      proposalId: "proposal-1",
      operationId: input.operationId,
      payloadHash: "hash-1",
    }),
    ...overrides,
  };
}

test("extracts facts, scopes repository reads, and persists a signed create-issue proposal", async () => {
  const calls: string[] = [];
  const result = await analyzeThread(context(), dependencies({
    model: {
      modelVersion: "openai/gpt-5-mini",
      complete: async (input) => {
        calls.push(input.schemaName);
        return input.schemaName === "signal_fact_extraction" ? facts() : {
          title: "Track migration",
          body: `Evidence: ${sourceMessages[0].permalink}`,
          assigneeSlackId: "U456",
          relatedCandidateIds: [],
        };
      },
    },
    github: {
      search: async (input) => {
        assert.deepEqual(input, { owner: "acme", repo: "signal", queries: ["migration"] });
        return [];
      },
      getIssue: async () => { throw new Error("unexpected target lookup"); },
    },
  }));

  assert.deepEqual(calls, ["signal_fact_extraction", "signal_mutation_draft"]);
  assert.equal(result.mutation.kind, "CREATE_ISSUE");
  assert.deepEqual(result.mutation.assignees, ["octocat"]);
  assert.match(result.mutation.body, /signal-operation:/);
  assert.equal(result.snapshotHash.length, 64);
  assert.deepEqual(result.metadata, { modelVersion: "openai/gpt-5-mini", promptVersion: "signal-analysis-prompt-v1", schemaVersion: 1 });
  assert.equal(result.persisted.proposalId, "proposal-1");
});

test("uses only an explicit open issue target for a progress comment", async () => {
  let targetLookups = 0;
  const result = await analyzeThread(context({ invocationText: "Update #42 with this progress" }), dependencies({
    github: {
      search: async () => [],
      getIssue: async (input) => {
        targetLookups += 1;
        assert.deepEqual(input, { owner: "acme", repo: "signal", issueNumber: 42 });
        return { id: "4200", number: 42, title: "Migration", htmlUrl: "https://github.com/acme/signal/issues/42", state: "open", isPullRequest: false, authorLogin: "octocat" };
      },
    },
  }));

  assert.equal(targetLookups, 1);
  assert.equal(result.mutation.kind, "ADD_PROGRESS_COMMENT");
  assert.equal(result.mutation.issueId, "4200");
  assert.equal(result.mutation.issueNumber, 42);
});

test("refuses unsupported evidence and ambiguous targets before persistence", async () => {
  let persisted = false;
  await assert.rejects(
    analyzeThread(context({ invocationText: "Update #42 and #43" }), dependencies({
      persistProposal: async () => {
        persisted = true;
        return { proposalId: "p", operationId: "o", payloadHash: "h" };
      },
    })),
    (error: unknown) => error instanceof AnalysisError && error.code === "analysis_target_invalid",
  );
  assert.equal(persisted, false);

  await assert.rejects(
    analyzeThread(context(), dependencies({
      model: { complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? {
        ...facts(),
        analysis: { ...facts().analysis, decisions: [{ text: "bad", evidence: [{ messageTs: "missing", permalink: "https://evil.example/evidence" }] }] },
      } : { title: "bad", body: "no evidence", assigneeSlackId: null, relatedCandidateIds: [] } },
    })),
    (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid",
  );
});

test("does not guess an unmapped assignee and rejects pull request targets", async () => {
  const result = await analyzeThread(context({ identityMappings: {} }), dependencies({
    model: {
      complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? facts() : {
        title: "Track migration",
        body: `Evidence: ${sourceMessages[0].permalink}`,
        assigneeSlackId: "U999",
        relatedCandidateIds: [],
      },
    },
  }));
  assert.deepEqual(result.mutation.kind === "CREATE_ISSUE" ? result.mutation.assignees : [], []);
  assert.match(result.analysis.uncertainties.join(" "), /assignee/i);

  await assert.rejects(
    analyzeThread(context({ invocationText: "Update #42" }), dependencies({
      github: { search: async () => [], getIssue: async () => ({ id: "4200", number: 42, title: "PR", htmlUrl: "https://github.com/acme/signal/pull/42", state: "open", isPullRequest: true, authorLogin: null }) },
    })),
    (error: unknown) => error instanceof AnalysisError && error.code === "analysis_target_invalid",
  );
});

test("does not persist when the thread has no actionable facts", async () => {
  let persisted = false;
  await assert.rejects(
    analyzeThread(context(), dependencies({
      model: {
        complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? {
          analysis: { decisions: [], tasks: [], blockers: [], uncertainties: ["No actionable request"] },
          searchQueries: [],
        } : { title: "unused", body: "unused", assigneeSlackId: null, relatedCandidateIds: [] },
      },
      persistProposal: async () => {
        persisted = true;
        return { proposalId: "p", operationId: "o", payloadHash: "h" };
      },
    })),
    (error: unknown) => error instanceof AnalysisError && error.code === "analysis_no_action",
  );
  assert.equal(persisted, false);
});

test("allows an actionable thread with no repository search terms", async () => {
  let searched = false;
  const result = await analyzeThread(context(), dependencies({
    model: {
      complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? { ...facts(), searchQueries: [] } : {
        title: "Track migration",
        body: `Evidence: ${sourceMessages[0].permalink}`,
        assigneeSlackId: null,
        relatedCandidateIds: [],
      },
    },
    github: {
      search: async () => {
        searched = true;
        return [];
      },
      getIssue: async () => { throw new Error("unexpected target lookup"); },
    },
  }));
  assert.equal(searched, false);
  assert.equal(result.mutation.kind, "CREATE_ISSUE");
});

test("rejects a GitHub URL outside the configured repository", async () => {
  await assert.rejects(
    analyzeThread(context({ invocationText: "Update https://github.com/other/project/issues/9" }), dependencies()),
    (error: unknown) => error instanceof AnalysisError && error.code === "analysis_target_invalid",
  );
});
