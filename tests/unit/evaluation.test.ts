import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Analysis } from "../../src/domain/contracts";
import { AnalysisError, analyzeThread, type AnalysisDependencies, type StoredAnalyzedProposal } from "../../src/services/analyze";
import { FactExtractionSchema } from "../../src/services/analysis-schemas";
import { evaluateCli } from "../../scripts/evaluate";
import { evaluationAnnotations } from "../evaluation/annotations";
import { CATEGORIES, citation, evaluationFixtures, replayDraft } from "../evaluation/fixtures";
import { evaluateCorpus, runFixture } from "../evaluation/harness";
import { emptyCounts, extractionMetric, scoreExtraction } from "../evaluation/scoring";

const projectDir = fileURLToPath(new URL("../../", import.meta.url));
const empty = (): Analysis => ({ decisions: [], tasks: [], blockers: [], uncertainties: [] });
const evidence = (index = 1) => [{ messageTs: `1800000000.${index}`, permalink: `https://slack.example/archives/C_UNIT/p${index}` }];
const task = (text: string, ownerSlackId: string | null = null, deadlineText: string | null = null, index = 1) => ({
  text, ownerSlackId, deadlineText, evidence: evidence(index),
});

test("evaluation corpus has distinct conversations and all required coverage categories", () => {
  const fixtures = evaluationFixtures();
  assert.equal(fixtures.length, 34);
  assert.equal(new Set(fixtures.map(({ id }) => id)).size, fixtures.length);
  assert.equal(new Set(fixtures.map(({ context }) => JSON.stringify(context.sourceMessages))).size, fixtures.length);
  assert.equal(new Set(fixtures.flatMap(({ categories }) => categories)).size, CATEGORIES.length);
  assert.equal(Object.keys(evaluationAnnotations()).length, fixtures.length);
});

test("real analysis validation matches every authored outcome without rejected persistence", async () => {
  const annotations = evaluationAnnotations();
  for (const fixture of evaluationFixtures()) {
    const actual = await runFixture(fixture);
    assert.equal(actual.outcome, annotations[fixture.id].outcome, fixture.id);
    const accepted = actual.outcome === "CREATE_ISSUE" || actual.outcome === "ADD_PROGRESS_COMMENT";
    assert.equal(actual.memoryPersistenceCalls, accepted ? 1 : 0, fixture.id);
    assert.equal(actual.contextMismatches, 0, fixture.id);
    assert.ok(actual.modelDoubleCalls <= 2, fixture.id);
    if (["E19", "E20", "E21", "E22", "E29", "E30", "E31"].includes(fixture.id)) {
      assert.equal(actual.modelDoubleCalls, 0, fixture.id);
    }
  }
});

test("offline aggregate exposes the deliberately omitted blocker and cannot claim model quality", async () => {
  const summary = await evaluateCorpus();
  assert.equal(summary.status, "PASS");
  assert.equal(summary.counts.outcomeMatches, 34);
  assert.equal(summary.counts.accepted, 18);
  assert.equal(summary.counts.rejected, 15);
  assert.equal(summary.counts.noAction, 1);
  assert.equal(summary.extraction.truePositive, 35);
  assert.equal(summary.extraction.falseNegative, 1);
  assert.equal(summary.extraction.falsePositive, 0);
  assert.equal(summary.extraction.required, 36);
  assert.equal(summary.extraction.recall, 35 / 36);
  assert.equal(summary.extraction.byDimension.blockers.falseNegative, 1);
  assert.equal(summary.modelQuality.status, "NOT_RUN");
  assert.equal(summary.modelQuality.providerRequests, 0);
  assert.equal(summary.modelQuality.recall, null);
  assert.equal(summary.modelQuality.extractionCriterionMet, null);
});

test("offline aggregates are deterministic despite production UUIDs and timings", async () => {
  assert.deepEqual(await evaluateCorpus(), await evaluateCorpus());
});

test("offline harness does not use the network", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("evaluation_network_forbidden");
  };
  try {
    const summary = await evaluateCorpus();
    assert.equal(summary.status, "PASS");
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scorer uses an exact inclusive 90 percent threshold and rejects rounded near misses", () => {
  const counts = emptyCounts();
  counts.tasks = { truePositive: 9, falsePositive: 0, falseNegative: 1 };
  assert.equal(extractionMetric(counts).recallCriterionMet, true);
  counts.tasks = { truePositive: 8999, falsePositive: 0, falseNegative: 1001 };
  assert.equal(extractionMetric(counts).recallCriterionMet, false);
  assert.equal(extractionMetric(counts).recall, 0.8999);
});

test("empty references yield no recall and never meet the extraction criterion", () => {
  const metric = extractionMetric(scoreExtraction(empty(), empty()));
  assert.equal(metric.required, 0);
  assert.equal(metric.recall, null);
  assert.equal(metric.precision, null);
  assert.equal(metric.recallCriterionMet, false);
});

test("null owner and deadline are not scored as true positives; invented values are false positives", () => {
  const expected = { ...empty(), tasks: [task("inspect headers")] };
  const actual = { ...empty(), tasks: [task("inspect headers", "U_GUESSED", "Monday")] };
  const metric = extractionMetric(scoreExtraction(expected, actual));
  assert.equal(metric.required, 1);
  assert.equal(metric.truePositive, 1);
  assert.equal(metric.byDimension.owners.falsePositive, 1);
  assert.equal(metric.byDimension.deadlines.falsePositive, 1);
  assert.equal(metric.recallCriterionMet, true);
  assert.equal(metric.noInventedValues, false);
});

test("dropping an owner and deadline loses their independent required assertions", () => {
  const expected = { ...empty(), tasks: [task("inspect headers", "U_ANA", "Friday")] };
  const actual = { ...empty(), tasks: [task("inspect headers")] };
  const metric = extractionMetric(scoreExtraction(expected, actual));
  assert.equal(metric.required, 3);
  assert.equal(metric.truePositive, 1);
  assert.equal(metric.byDimension.owners.falseNegative, 1);
  assert.equal(metric.byDimension.deadlines.falseNegative, 1);
});

test("a hallucinated replacement counts as both a missed reference and a false assertion", () => {
  const expected = { ...empty(), tasks: [task("inspect headers")] };
  const actual = { ...empty(), tasks: [task("publish the audit")] };
  const metric = extractionMetric(scoreExtraction(expected, actual));
  assert.equal(metric.truePositive, 0);
  assert.equal(metric.falseNegative, 1);
  assert.equal(metric.falsePositive, 1);
});

test("duplicate predictions cannot inflate recall or hide extra assertions", () => {
  const expected = { ...empty(), tasks: [task("inspect headers")] };
  const actual = { ...empty(), tasks: [task("inspect headers"), task("inspect headers")] };
  const metric = extractionMetric(scoreExtraction(expected, actual));
  assert.equal(metric.truePositive, 1);
  assert.equal(metric.falsePositive, 1);
  assert.equal(metric.recall, 1);
  assert.equal(metric.precision, 0.5);
});

test("fact ordering and harmless quote case/spacing do not change matches", () => {
  const expected = { ...empty(), tasks: [task("inspect headers"), task("review limits", null, null, 2)] };
  const actual = { ...empty(), tasks: [task("Review limits", null, null, 2), task(" Inspect  headers ")] };
  const metric = extractionMetric(scoreExtraction(expected, actual));
  assert.equal(metric.truePositive, 2);
  assert.equal(metric.falsePositive, 0);
  assert.equal(metric.falseNegative, 0);
});

test("identical owner/deadline values on the wrong task receive no assignment credit", () => {
  const expected = { ...empty(), tasks: [task("inspect headers", "U_ANA", "Friday"), task("review limits", null, null, 2)] };
  const actual = { ...empty(), tasks: [task("inspect headers"), task("review limits", "U_ANA", "Friday", 2)] };
  const counts = scoreExtraction(expected, actual);
  assert.equal(counts.tasks.truePositive, 2);
  assert.equal(counts.owners.truePositive, 0);
  assert.equal(counts.owners.falsePositive, 1);
  assert.equal(counts.owners.falseNegative, 1);
  assert.equal(counts.deadlines.falsePositive, 1);
  assert.equal(counts.deadlines.falseNegative, 1);
});

test("every scored owner and deadline is bound to the exact source evidence tuple", () => {
  const expected = { ...empty(), tasks: [task("inspect headers", "U_ANA", "Friday")] };
  const actualTask = task("inspect headers", "U_ANA", "Friday");
  actualTask.evidence[0].permalink = "https://foreign.slack.example/archives/C_OTHER/p1";
  const metric = extractionMetric(scoreExtraction(expected, { ...empty(), tasks: [actualTask] }));
  assert.equal(metric.truePositive, 0);
  assert.equal(metric.falsePositive, 3);
  assert.equal(metric.falseNegative, 3);
});

test("an extra citation is not silently removed to improve scoring", () => {
  const expected = { ...empty(), tasks: [task("inspect headers")] };
  const actualTask = task("inspect headers");
  actualTask.evidence.push(...evidence(2));
  const counts = scoreExtraction(expected, { ...empty(), tasks: [actualTask] });
  assert.equal(counts.tasks.truePositive, 0);
  assert.equal(counts.tasks.falsePositive, 1);
  assert.equal(counts.tasks.falseNegative, 1);
});

test("changing gold labels cannot change the response under evaluation", async () => {
  const fixtures = evaluationFixtures();
  const baseline = await evaluateCorpus(fixtures);
  const annotations = evaluationAnnotations();
  annotations.E03.decisions = [["a deliberately incorrect reference label", 0]];
  const changed = await evaluateCorpus(fixtures, annotations);
  assert.equal(changed.status, "FAIL");
  assert.equal(changed.counts.accepted, baseline.counts.accepted);
  assert.equal(changed.counts.modelDoubleCalls, baseline.counts.modelDoubleCalls);
  assert.equal(changed.extraction.truePositive, baseline.extraction.truePositive - 1);
  assert.equal(changed.extraction.falsePositive, 1);
});

test("a rejected positive fixture contributes all required facts as false negatives", async () => {
  const fixtures = evaluationFixtures();
  fixtures[0].response = {};
  const summary = await evaluateCorpus(fixtures);
  assert.equal(summary.status, "FAIL");
  assert.equal(summary.counts.outcomeMismatches, 1);
  assert.equal(summary.extraction.required, 36);
  assert.equal(summary.extraction.falseNegative, 4);
  assert.equal(summary.extraction.recallCriterionMet, false);
});

test("a schema-valid wrong category fails even with recall above 90 percent", async () => {
  const fixtures = evaluationFixtures();
  const fixture = fixtures.find(({ id }) => id === "E03")!;
  fixture.response = { analysis: { ...empty(), tasks: [{ text: "keep the cache optional", ownerSlackId: null,
    deadlineText: null, evidence: [citation(fixture.context, 0)] }] }, searchQueries: [] };
  const summary = await evaluateCorpus(fixtures);
  assert.equal(summary.counts.outcomeMismatches, 0);
  assert.equal(summary.extraction.recallCriterionMet, true);
  assert.equal(summary.extraction.falsePositive, 1);
  assert.equal(summary.status, "FAIL");
});

test("an actionable claim on a no-action reference fails the boundary and precision gates", async () => {
  const fixtures = evaluationFixtures();
  const fixture = fixtures.find(({ id }) => id === "E17")!;
  fixture.response = { analysis: { ...empty(), tasks: [{ text: "Thanks for joining the planning sync", ownerSlackId: null,
    deadlineText: null, evidence: [citation(fixture.context, 0)] }] }, searchQueries: [] };
  const summary = await evaluateCorpus(fixtures);
  assert.equal(summary.counts.outcomeMismatches, 1);
  assert.equal(summary.extraction.falsePositive, 1);
  assert.equal(summary.status, "FAIL");
});

test("corpus validation rejects empty, small, duplicate, and unlabeled inputs", async () => {
  await assert.rejects(evaluateCorpus([], {}), /evaluation_invalid_corpus/);
  await assert.rejects(evaluateCorpus(evaluationFixtures().slice(0, 19)), /evaluation_invalid_corpus/);
  const duplicate = evaluationFixtures();
  duplicate[1].id = duplicate[0].id;
  await assert.rejects(evaluateCorpus(duplicate), /evaluation_invalid_corpus/);
  const labels = evaluationAnnotations();
  delete labels.E01;
  await assert.rejects(evaluateCorpus(evaluationFixtures(), labels), /evaluation_invalid_corpus/);
});

test("a valid proposal from another tenant cannot be restored as this tenant's evidence", async () => {
  const fixture = evaluationFixtures()[0];
  let modelCalls = 0;
  let persists = 0;
  const dependencies: AnalysisDependencies = {
    model: { complete: async ({ schemaName }) => {
      modelCalls += 1;
      return schemaName === "signal_fact_extraction" ? structuredClone(fixture.response)
        : replayDraft(FactExtractionSchema.parse(fixture.response).analysis);
    } },
    github: { search: async () => [], getIssue: async () => { throw new Error("evaluation_unexpected_read"); } },
    persistProposal: async (input) => {
      persists += 1;
      return { proposalId: "offline-tenant-proposal", operationId: input.operationId, payloadHash: input.payloadHash };
    },
  };
  const first = await analyzeThread(structuredClone(fixture.context), dependencies);
  const stored: StoredAnalyzedProposal = {
    tenantId: fixture.context.tenantId, threadId: fixture.context.threadId, proposalId: first.persisted.proposalId,
    version: 1, operationId: first.operationId, payloadHash: first.payloadHash, snapshotHash: first.snapshotHash,
    actionFingerprint: first.actionFingerprint, mutation: first.mutation, analysis: first.analysis, metadata: first.metadata,
  };
  let scopedLookup = false;
  await assert.rejects(analyzeThread({ ...structuredClone(fixture.context), tenantId: "synthetic-tenant-b" }, {
    ...dependencies,
    findExistingProposal: async ({ tenantId }) => {
      scopedLookup = tenantId === "synthetic-tenant-b";
      return stored;
    },
  }), (error: unknown) => error instanceof AnalysisError && error.code === "analysis_persistence_failed");
  assert.equal(scopedLookup, true);
  assert.equal(modelCalls, 2);
  assert.equal(persists, 1);
});

test("the CLI writes one aggregate JSON record with no source, identifiers, credentials, or stderr", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "scripts/evaluate.ts", "--offline"], {
    cwd: projectDir, encoding: "utf8", env: { PATH: process.env.PATH, OPENROUTER_API_KEY: "SYNTHETIC_NEVER_LOG_KEY" },
  });
  assert.equal(result.status, 0);
  assert.ok(result.stderr.length === 0, "stderr must be empty");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, "deterministic_offline_response_replay");
  assert.equal(summary.modelQuality.providerRequests, 0);
  assert.ok(!/SYNTHETIC_NEVER_LOG_KEY|https?:|U_ANA|synthetic-tenant|document the release|signal-operation|stack|prompt/i.test(result.stdout), "aggregate must contain no fixture or exception content");
  assert.deepEqual(Object.keys(summary).sort(), ["schemaVersion", "mode", "status", "counts", "coverage", "coverageComplete", "outcomes", "extraction", "modelQuality"].sort());
});

test("live mode and unknown arguments fail closed without echoing arguments", async () => {
  for (const args of [["--live"], ["--offline", "--live"], ["SYNTHETIC_PRIVATE_ARGUMENT"]]) {
    const result = await evaluateCli(args);
    assert.equal(result.exitCode, 2);
    assert.equal(result.summary.status, "FAIL");
    assert.equal(result.summary.modelQuality.providerRequests, 0);
    assert.ok(!JSON.stringify(result.summary).includes("SYNTHETIC_PRIVATE_ARGUMENT"));
  }
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "scripts/evaluate.ts", "--live"], {
    cwd: projectDir, encoding: "utf8", env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.length === 0);
  assert.equal(JSON.parse(result.stdout).errorCode, "evaluation_invalid_arguments");
});

test("importing the evaluator never starts evaluation or writes a report", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", "await import('./scripts/evaluate.ts')"], {
    cwd: projectDir, encoding: "utf8", env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length === 0);
  assert.ok(result.stderr.length === 0);
});
