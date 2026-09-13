import type { Analysis } from "../../src/domain/contracts";
import { AnalysisError, analyzeThread, type AnalysisErrorCode } from "../../src/services/analyze";
import { FactExtractionSchema } from "../../src/services/analysis-schemas";
import { annotatedAnalysis, evaluationAnnotations, type Annotation, type ExpectedOutcome } from "./annotations";
import { CATEGORIES, evaluationFixtures, replayDraft, type Category, type EvaluationFixture } from "./fixtures";
import { addCounts, emptyCounts, extractionMetric, scoreExtraction } from "./scoring";

const ERROR_CODES: AnalysisErrorCode[] = ["analysis_invalid_context", "analysis_no_action", "analysis_target_invalid",
  "analysis_provider_unavailable", "analysis_model_invalid", "analysis_persistence_failed"];
type Outcome = ExpectedOutcome | "unexpected_error";

export interface FixtureObservation {
  outcome: Outcome;
  analysis?: Analysis;
  assignees: string[];
  modelDoubleCalls: number;
  githubDoubleReads: number;
  memoryPersistenceCalls: number;
  contextMismatches: number;
  schemaChecks: number;
  schemaValid: number;
}

/** Only test doubles enter the production service; no credentials or IO clients. */
export async function runFixture(fixture: EvaluationFixture): Promise<FixtureObservation> {
  const observation: FixtureObservation = {
    outcome: "unexpected_error", assignees: [], modelDoubleCalls: 0, githubDoubleReads: 0,
    memoryPersistenceCalls: 0, contextMismatches: 0, schemaChecks: 0, schemaValid: 0,
  };
  let parsedResponse: ReturnType<typeof FactExtractionSchema.safeParse> | undefined;
  const { context } = fixture;
  const sameRepository = (input: { owner: string; repo: string }): void => {
    if (input.owner !== context.repository.owner || input.repo !== context.repository.repo) {
      observation.contextMismatches += 1;
      throw new Error("evaluation_repository_mismatch");
    }
  };
  try {
    const result = await analyzeThread(structuredClone(context), {
      model: {
        modelVersion: "offline-authored-response-v1",
        complete: async ({ schemaName }) => {
          observation.modelDoubleCalls += 1;
          if (observation.modelDoubleCalls > 2) throw new Error("evaluation_request_budget");
          if (schemaName === "signal_fact_extraction" && observation.modelDoubleCalls === 1) {
            const response: unknown = structuredClone(fixture.response);
            parsedResponse = FactExtractionSchema.safeParse(response);
            observation.schemaChecks += 1;
            observation.schemaValid += parsedResponse.success ? 1 : 0;
            return response;
          }
          if (schemaName === "signal_mutation_draft" && observation.modelDoubleCalls === 2 && parsedResponse?.success) {
            return { ...replayDraft(parsedResponse.data.analysis), ...structuredClone(fixture.draft ?? {}) };
          }
          throw new Error("evaluation_unexpected_model_call");
        },
      },
      github: {
        search: async (input) => {
          observation.githubDoubleReads += 1;
          sameRepository(input);
          if (fixture.searchFails) throw new Error("evaluation_simulated_repository_unavailable");
          return structuredClone(fixture.candidates ?? []);
        },
        getIssue: async (input) => {
          observation.githubDoubleReads += 1;
          sameRepository(input);
          if (!fixture.target) throw new Error("evaluation_unexpected_target_read");
          return structuredClone(fixture.target);
        },
      },
      persistProposal: async (input) => {
        observation.memoryPersistenceCalls += 1;
        if (input.tenantId !== context.tenantId || input.threadId !== context.threadId ||
            input.version !== context.version || input.mutation.repoId !== context.repository.repoId ||
            input.mutation.owner !== context.repository.owner || input.mutation.repo !== context.repository.repo ||
            input.snapshot.content.some((message, index) => message.permalink !== context.sourceMessages[index]?.permalink)) {
          observation.contextMismatches += 1;
          throw new Error("evaluation_persistence_context_mismatch");
        }
        return { proposalId: "offline-proposal", operationId: input.operationId, payloadHash: input.payloadHash };
      },
    });
    observation.outcome = result.mutation.kind;
    observation.analysis = result.analysis;
    observation.assignees = result.mutation.kind === "CREATE_ISSUE" ? result.mutation.assignees : [];
  } catch (error: unknown) {
    if (error instanceof AnalysisError && ERROR_CODES.includes(error.code)) observation.outcome = error.code;
    // No-action only follows successful production schema and grounding checks.
    // All other rejected responses get no extraction credit.
    if (observation.outcome === "analysis_no_action" && parsedResponse?.success) observation.analysis = parsedResponse.data.analysis;
  }
  return observation;
}

export async function evaluateCorpus(
  fixtures: EvaluationFixture[] = evaluationFixtures(),
  annotations: Record<string, Annotation> = evaluationAnnotations(),
) {
  const ids = new Set(fixtures.map(({ id }) => id));
  if (fixtures.length < 20 || ids.size !== fixtures.length || Object.keys(annotations).length !== fixtures.length ||
      fixtures.some(({ id }) => !Object.hasOwn(annotations, id))) throw new Error("evaluation_invalid_corpus");
  const coverage = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<Category, number>;
  const byDimension = emptyCounts();
  const outcomes: Record<Outcome, number> = {
    CREATE_ISSUE: 0, ADD_PROGRESS_COMMENT: 0, analysis_invalid_context: 0, analysis_no_action: 0,
    analysis_target_invalid: 0, analysis_provider_unavailable: 0, analysis_model_invalid: 0,
    analysis_persistence_failed: 0, unexpected_error: 0,
  };
  const counts = {
    fixtures: fixtures.length, outcomeMatches: 0, outcomeMismatches: 0,
    rejected: 0, noAction: 0, accepted: 0, extractionFixtures: 0,
    modelDoubleCalls: 0, githubDoubleReads: 0, memoryPersistenceCalls: 0,
    boundaryViolations: 0, contextMismatches: 0, schemaChecks: 0, schemaValid: 0,
    assignmentChecks: 0, assignmentMatches: 0, uncertaintyChecks: 0, uncertaintyMatches: 0,
  };
  for (const fixture of fixtures) {
    // Compute from actual service output before consulting expected labels.
    const observation = await runFixture(fixture);
    const annotation = annotations[fixture.id];
    for (const category of new Set(fixture.categories)) {
      if (!CATEGORIES.includes(category)) throw new Error("evaluation_invalid_category");
      coverage[category] += 1;
    }
    outcomes[observation.outcome] += 1;
    if (observation.outcome === annotation.outcome) counts.outcomeMatches += 1;
    else counts.outcomeMismatches += 1;
    const accepted = observation.outcome === "CREATE_ISSUE" || observation.outcome === "ADD_PROGRESS_COMMENT";
    if (accepted) counts.accepted += 1;
    else if (observation.outcome === "analysis_no_action") counts.noAction += 1;
    else counts.rejected += 1;
    if (observation.memoryPersistenceCalls !== (accepted ? 1 : 0) || observation.modelDoubleCalls > 2) counts.boundaryViolations += 1;
    for (const key of ["modelDoubleCalls", "githubDoubleReads", "memoryPersistenceCalls", "contextMismatches", "schemaChecks", "schemaValid"] as const) {
      counts[key] += observation[key];
    }
    const expectsAnalysis = annotation.outcome === "CREATE_ISSUE" || annotation.outcome === "ADD_PROGRESS_COMMENT" || annotation.outcome === "analysis_no_action";
    // Error fixtures have rejection oracles, not fabricated correct extractions.
    // A rejected positive fixture still contributes every required fact as FN.
    if (expectsAnalysis) {
      counts.extractionFixtures += 1;
      addCounts(byDimension, scoreExtraction(annotatedAnalysis(fixture.context, annotation), observation.analysis));
      for (const phrase of annotation.uncertaintyIncludes ?? []) {
        counts.uncertaintyChecks += 1;
        if (observation.analysis?.uncertainties.some((text) => text.includes(phrase))) counts.uncertaintyMatches += 1;
      }
      if (annotation.outcome === "CREATE_ISSUE") {
        counts.assignmentChecks += 1;
        if (accepted && JSON.stringify(observation.assignees) === JSON.stringify(annotation.assignees ?? [])) counts.assignmentMatches += 1;
      }
    }
  }
  const extraction = extractionMetric(byDimension);
  const coverageComplete = CATEGORIES.every((category) => coverage[category] > 0);
  const pass = coverageComplete && counts.outcomeMismatches === 0 && counts.boundaryViolations === 0 && counts.contextMismatches === 0 &&
    counts.assignmentChecks === counts.assignmentMatches && counts.uncertaintyChecks === counts.uncertaintyMatches &&
    extraction.recallCriterionMet && extraction.noInventedValues;
  return {
    schemaVersion: 1,
    mode: "deterministic_offline_response_replay" as const,
    status: pass ? "PASS" as const : "FAIL" as const,
    counts, coverage, coverageComplete, outcomes, extraction,
    modelQuality: { status: "NOT_RUN" as const, providerRequests: 0, recall: null, extractionCriterionMet: null },
  };
}
