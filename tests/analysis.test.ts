import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis } from "../src/domain/contracts";
import { AnalysisError, analyzeThread, type AnalysisContext, type AnalysisDependencies, type ProposalPersistenceInput, type StoredAnalyzedProposal } from "../src/services/analyze";
import { FactExtractionSchema, FACT_EXTRACTION_JSON_SCHEMA, MutationDraftSchema, MUTATION_DRAFT_JSON_SCHEMA } from "../src/services/analysis-schemas";

const sourceMessages = [
  { ts: "1710000000.000001", user: "U123", text: "We should track the migration and ship it this week.", permalink: "https://slack.example/archives/C123/p1710000000000001" },
  { ts: "1710000000.000002", user: "U456", text: "I will verify deployment this week after the issue is opened.", permalink: "https://slack.example/archives/C123/p1710000000000002" },
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
        title: "Track the migration",
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
      payloadHash: input.payloadHash,
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
          title: "Track the migration",
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
  assert.deepEqual(result.metadata, { modelVersion: "openai/gpt-5-mini", promptVersion: "signal-analysis-prompt-v2", schemaVersion: 1 });
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
        title: "Track the migration",
        body: `Evidence: ${sourceMessages[0].permalink}`,
        assigneeSlackId: "U456",
        relatedCandidateIds: [],
      },
    },
  }));
  assert.deepEqual(result.mutation.kind === "CREATE_ISSUE" ? result.mutation.assignees : [], []);
  assert.match(result.analysis.uncertainties.join(" "), /identity mapping/i);

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
        title: "Track the migration",
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

function record(input: ProposalPersistenceInput): StoredAnalyzedProposal {
  return {
    tenantId: input.tenantId, threadId: input.threadId, proposalId: `proposal-${input.version}`, version: input.version,
    operationId: input.operationId, payloadHash: input.payloadHash, snapshotHash: input.snapshot.snapshotHash,
    actionFingerprint: input.actionFingerprint, mutation: input.mutation, analysis: input.analysis,
    metadata: input.metadata, candidates: input.candidates, analysisDurationMs: input.analysisDurationMs,
  };
}

function inMemoryProposals() {
  const records = new Map<string, StoredAnalyzedProposal>();
  const inputs: ProposalPersistenceInput[] = [];
  const persistence: Pick<AnalysisDependencies, "persistProposal" | "findExistingProposal"> = {
    findExistingProposal: async ({ tenantId, threadId, actionFingerprint }) => {
      const stored = records.get(actionFingerprint);
      return stored?.tenantId === tenantId && stored.threadId === threadId ? structuredClone(stored) : null;
    },
    persistProposal: async (input) => {
      inputs.push(input);
      const prior = records.get(input.actionFingerprint);
      if (prior) return { proposalId: prior.proposalId, operationId: prior.operationId, payloadHash: prior.payloadHash, existing: prior };
      const stored = record(input);
      records.set(stored.actionFingerprint, stored);
      return { proposalId: stored.proposalId, operationId: stored.operationId, payloadHash: stored.payloadHash };
    },
  };
  return { records, inputs, persistence };
}

const linkedCandidate = { id: "4200", number: 42, title: "Migration", htmlUrl: "https://github.com/acme/signal/issues/42", state: "open" as const, isPullRequest: false, authorLogin: "octocat" };

test("real analysis inputs advance create to linked-issue progress at the next version", async () => {
  const store = inMemoryProposals();
  const created = await analyzeThread(context(), dependencies(store.persistence));
  assert.equal(created.mutation.kind, "CREATE_ISSUE");
  const update = { ts: "1710000000.000003", user: "U456", text: "Deployment is verified. Please post this progress.", permalink: "https://slack.example/archives/C123/p1710000000000003" };
  const schemaCalls: string[] = [];
  const progressContext = context({
    version: 2, linkedIssue: { issueId: linkedCandidate.id, issueNumber: linkedCandidate.number },
    invocationText: "Please post this progress", sourceMessages: [...sourceMessages, update], previousSourceMessages: sourceMessages,
  });
  const progressed = await analyzeThread(progressContext, dependencies({
    ...store.persistence,
    github: { search: async () => [], getIssue: async () => linkedCandidate },
    model: { complete: async (input) => {
      schemaCalls.push(input.schemaName);
      const parsed = JSON.parse(input.user);
      if (input.schemaName === "signal_fact_extraction") {
        assert.equal(parsed.messages.includes(update.text), true);
        assert.equal(parsed.messages.includes(sourceMessages[0].text), false);
        return { analysis: { decisions: [{ text: "Deployment is verified", evidence: [{ messageTs: update.ts, permalink: update.permalink }] }], tasks: [], blockers: [], uncertainties: [] }, searchQueries: [] };
      }
      assert.equal(parsed.actionKind, "ADD_PROGRESS_COMMENT");
      assert.equal(parsed.explicitTarget.id, linkedCandidate.id);
      assert.equal(parsed.facts.analysis.decisions.length, 1);
      return { title: "Deployment is verified", body: `Deployment is verified\nEvidence: ${update.permalink}`, assigneeSlackId: null, relatedCandidateIds: [linkedCandidate.id] };
    } },
  }));
  assert.deepEqual(schemaCalls, ["signal_fact_extraction", "signal_mutation_draft"]);
  assert.equal(progressed.version, 2);
  assert.equal(progressed.mutation.kind, "ADD_PROGRESS_COMMENT");
  assert.equal(progressed.mutation.issueId, linkedCandidate.id);
  assert.notEqual(progressed.operationId, created.operationId);
  assert.notEqual(progressed.actionFingerprint, created.actionFingerprint);
  assert.equal(store.inputs[1].version, 2);
  assert.equal(store.inputs[1].analysis.decisions[0].text, "Deployment is verified");
  assert.equal(typeof store.inputs[1].analysisDurationMs, "number");
  const replay = await analyzeThread({ ...progressContext, version: 3 }, dependencies({
    ...store.persistence,
    model: { complete: async () => { throw new Error("inference must not rerun"); } },
    github: { search: async () => { throw new Error("search must not rerun"); }, getIssue: async () => linkedCandidate },
  }));
  assert.equal(replay.reused, true);
  assert.equal(replay.version, 2);
  assert.equal(replay.operationId, progressed.operationId);
  assert.equal(replay.mutation.body === progressed.mutation.body, true);
  assert.equal(store.inputs.length, 2);
});

test("exact create fingerprint returns stored bytes and version without model/search/persistence", async () => {
  const store = inMemoryProposals();
  const first = await analyzeThread(context(), dependencies(store.persistence));
  const repeated = await analyzeThread(context({ version: 9 }), dependencies({
    findExistingProposal: store.persistence.findExistingProposal,
    persistProposal: async () => { throw new Error("must not persist again"); },
    model: { complete: async () => { throw new Error("must not infer again"); } },
    github: { search: async () => { throw new Error("must not search again"); }, getIssue: async () => { throw new Error("must not choose a target"); } },
  }));
  assert.equal(repeated.reused, true);
  assert.equal(repeated.version, 1);
  assert.equal(repeated.mutation.body === first.mutation.body, true);
  assert.equal(repeated.operationId, first.operationId);
  assert.equal(repeated.payloadHash, first.payloadHash);
});

test("a persistence race returns the stored winner, never new bytes under its proposal id", async () => {
  const store = inMemoryProposals();
  const first = await analyzeThread(context(), dependencies(store.persistence));
  const loser = await analyzeThread(context({ version: 2 }), dependencies({
    persistProposal: store.persistence.persistProposal,
    model: { complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? facts() : { title: "Verify deployment", body: "Verify deployment", assigneeSlackId: null, relatedCandidateIds: [] } },
  }));
  assert.equal(loser.reused, true);
  assert.equal(loser.version, 1);
  assert.equal(loser.mutation.body === first.mutation.body, true);
  assert.equal(loser.payloadHash, first.payloadHash);
  assert.equal(loser.operationId, first.operationId);
});

test("id-only persistence races and lookup failures fail closed", async () => {
  for (const overrides of [
    { persistProposal: async () => ({ proposalId: "existing", operationId: "old", payloadHash: "old-hash" }) },
    { findExistingProposal: async () => { throw new Error("sensitive database error"); } },
  ]) {
    await assert.rejects(analyzeThread(context(), dependencies(overrides)), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_persistence_failed" && !error.message.includes("sensitive"));
  }
});

test("a race returning only ids can reload the immutable winner through the lookup", async () => {
  const store = inMemoryProposals();
  const first = await analyzeThread(context(), dependencies(store.persistence));
  const saved = [...store.records.values()][0];
  let lookups = 0;
  const repeated = await analyzeThread(context({ version: 2 }), dependencies({
    findExistingProposal: async () => ++lookups === 1 ? null : { ...saved, metadata: undefined },
    persistProposal: async () => first.persisted,
  }));
  assert.equal(lookups, 2);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.version, 1);
  assert.equal(repeated.mutation.body === first.mutation.body, true);
  assert.equal(repeated.metadata.modelVersion, "unknown");
});

test("cross-tenant, cross-thread and tampered stored winners are refused without inference", async () => {
  const store = inMemoryProposals();
  await analyzeThread(context(), dependencies(store.persistence));
  const original = [...store.records.values()][0];
  for (const stored of [
    { ...original, tenantId: "other-tenant" },
    { ...original, threadId: "other-thread" },
    { ...original, version: 2 },
    { ...original, mutation: { ...original.mutation, body: "Tampered" } },
    { ...original, actionFingerprint: "bad" },
  ]) {
    await assert.rejects(analyzeThread(context(), dependencies({
      findExistingProposal: async () => stored,
      model: { complete: async () => { throw new Error("inference must not run"); } },
    })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_persistence_failed");
  }
});

test("spoofed source timestamps, links, or uncited claim text never reach drafting/persistence", async () => {
  const cases = [
    { text: "Invented completed work", evidence: facts().analysis.decisions[0].evidence },
    { text: "Track the migration", evidence: [{ messageTs: sourceMessages[0].ts, permalink: sourceMessages[1].permalink }] },
    { text: "Track the migration", evidence: [{ messageTs: sourceMessages[1].ts, permalink: sourceMessages[1].permalink }] },
    { text: "Track the migration", evidence: [] },
  ];
  for (const decision of cases) {
    let calls = 0;
    let persisted = false;
    await assert.rejects(analyzeThread(context(), dependencies({
      model: { complete: async () => { calls += 1; return { ...facts(), analysis: { ...facts().analysis, decisions: [decision] } }; } },
      persistProposal: async (input) => { persisted = true; return record(input); },
    })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid");
    assert.equal(calls, 1);
    assert.equal(persisted, false);
  }
});

test("an owner mapping alone cannot authorize fact or draft assignment", async () => {
  for (const stage of ["fact", "draft"]) {
    await assert.rejects(analyzeThread(context({ identityMappings: { U123: "mapped-but-unassigned", U456: "octocat" } }), dependencies({
      model: { complete: async ({ schemaName }) => {
        if (schemaName === "signal_fact_extraction") {
          const value = facts();
          if (stage === "fact") value.analysis.tasks[0].ownerSlackId = "U123";
          return value;
        }
        return { title: "Migration", body: "Verify deployment", assigneeSlackId: "U123", relatedCandidateIds: [] };
      } },
    })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid");
  }
});

test("deadlines must be literal wording in the cited task statement", async () => {
  for (const deadlineText of ["2099-12-31", "next week"]) {
    const extraction = facts();
    extraction.analysis.tasks[0].deadlineText = deadlineText;
    await assert.rejects(analyzeThread(context(), dependencies({ model: { complete: async () => extraction } })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid");
  }
  const unrelatedDeadline = context({ sourceMessages: [sourceMessages[0], { ...sourceMessages[1], text: "I will verify deployment after the issue is opened." }] });
  await assert.rejects(analyzeThread(unrelatedDeadline, dependencies()), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid");
});

test("speaker identity without a commitment does not establish ownership", async () => {
  for (const text of ["Someone should verify deployment this week.", "I will not verify deployment this week.", "I will ask someone else to verify deployment this week."]) {
    await assert.rejects(analyzeThread(context({ sourceMessages: [sourceMessages[0], { ...sourceMessages[1], text }] }), dependencies()), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid");
  }
});

test("draft body cannot invent an owner, deadline, claim, or evidence label after extraction", async () => {
  for (const body of [
    "Verify deployment\nOwner: U999",
    "Verify deployment\nDeadline: tomorrow",
    "Verify deployment\nDeadline: 2099-12-31",
    `All security checks passed\nEvidence: ${sourceMessages[0].permalink}`,
    `[Already approved](${sourceMessages[0].permalink})`,
  ]) {
    let persisted = false;
    await assert.rejects(analyzeThread(context(), dependencies({
      model: { complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? facts() : { title: "Track the migration", body, assigneeSlackId: null, relatedCandidateIds: [] } },
      persistProposal: async (input) => { persisted = true; return record(input); },
    })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid");
    assert.equal(persisted, false);
  }
});

test("draft can combine validated fact, owner, literal deadline and evidence lines", async () => {
  const body = `## Tasks\n- Verify deployment\nOwner: <@U456>\nDeadline: this week\nEvidence: ${sourceMessages[1].permalink}`;
  const result = await analyzeThread(context(), dependencies({
    model: { complete: async ({ schemaName }) => schemaName === "signal_fact_extraction" ? facts() : { title: "Verify deployment", body, assigneeSlackId: "U456", relatedCandidateIds: [] } },
  }));
  assert.equal(result.mutation.body.startsWith(body), true);
});

test("mapped explicit Slack assignments are grounded and ambiguous deadlines stay unresolved", async () => {
  const result = await analyzeThread(context({ sourceMessages: [sourceMessages[0], { ...sourceMessages[1], user: "U123", text: "<@U456> will verify deployment this week." }] }), dependencies());
  assert.equal(result.mutation.kind, "CREATE_ISSUE");
  assert.deepEqual(result.mutation.assignees, ["octocat"]);
  assert.equal(result.analysis.tasks[0].deadlineText, "this week");
  assert.equal(result.analysis.uncertainties.some((value) => value.includes("unresolved")), true);
});

test("linked issue identity drift, closed targets and PR URLs fail before inference", async () => {
  for (const changed of [{ ...linkedCandidate, id: "9999" }, { ...linkedCandidate, number: 43 }, { ...linkedCandidate, state: "closed" as const }, { ...linkedCandidate, htmlUrl: "https://github.com/other/repo/issues/42" }]) {
    await assert.rejects(analyzeThread(context({ linkedIssue: { id: linkedCandidate.id, number: 42 } }), dependencies({
      model: { complete: async () => { throw new Error("must validate target first"); } },
      github: { search: async () => [], getIssue: async () => changed },
    })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_target_invalid");
  }
  await assert.rejects(analyzeThread(context({ invocationText: "Update https://github.com/acme/signal/pull/42" }), dependencies()), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_target_invalid");
});

test("an explicit valid issue overrides a linked issue and candidates stay within five", async () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({ ...linkedCandidate, id: String(index + 1), number: index + 1, htmlUrl: `https://github.com/acme/signal/issues/${index + 1}` }));
  const result = await analyzeThread(context({ invocationText: "Update #42", linkedIssue: { id: "9900", number: 99 } }), dependencies({
    github: { search: async () => candidates, getIssue: async ({ issueNumber }) => { assert.equal(issueNumber, 42); return linkedCandidate; } },
  }));
  assert.equal(result.mutation.kind, "ADD_PROGRESS_COMMENT");
  assert.equal(result.mutation.issueNumber, 42);
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates[0].id, linkedCandidate.id);
});

test("unchanged progress snapshots do not trigger inference or a fresh proposal", async () => {
  await assert.rejects(analyzeThread(context({ linkedIssue: { id: "4200", number: 42 }, previousSourceMessages: sourceMessages }), dependencies({
    github: { search: async () => [], getIssue: async () => linkedCandidate },
    model: { complete: async () => { throw new Error("no new facts"); } },
  })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_no_action");
});

test("progress extraction refuses old evidence even when it remains in the full current snapshot", async () => {
  const update = { ...sourceMessages[1], text: "Deployment is now verified.", editedAt: "1710000001.000002" };
  await assert.rejects(analyzeThread(context({
    version: 2, linkedIssue: { id: "4200", number: 42 }, previousSourceMessages: sourceMessages,
    sourceMessages: [sourceMessages[0], update],
  }), dependencies({
    github: { search: async () => [], getIssue: async () => linkedCandidate },
    model: { complete: async (input) => {
      const prompt = JSON.parse(input.user);
      assert.equal(prompt.messages.includes(update.text), true);
      assert.equal(prompt.messages.includes(sourceMessages[0].text), false);
      return facts();
    } },
  })), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_model_invalid");
});

test("fact bounds and mutation marker capacity agree with model response schemas", () => {
  const extraction = facts();
  extraction.analysis.tasks = Array.from({ length: 21 }, () => extraction.analysis.tasks[0]);
  assert.equal(FactExtractionSchema.safeParse(extraction).success, false);
  assert.equal(FACT_EXTRACTION_JSON_SCHEMA.properties.analysis.properties.tasks.maxItems, 20);
  const maxBody = MUTATION_DRAFT_JSON_SCHEMA.properties.body.maxLength;
  assert.equal(MutationDraftSchema.safeParse({ title: "Test", body: "a".repeat(maxBody), assigneeSlackId: null, relatedCandidateIds: [] }).success, true);
  assert.equal(MutationDraftSchema.safeParse({ title: "Test", body: "a".repeat(maxBody + 1), assigneeSlackId: null, relatedCandidateIds: [] }).success, false);
});
