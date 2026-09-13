import type { Analysis, Evidence } from "../../src/domain/contracts";

export const DIMENSIONS = ["decisions", "tasks", "owners", "deadlines", "blockers"] as const;
export type Dimension = typeof DIMENSIONS[number];
export type Counts = { truePositive: number; falsePositive: number; falseNegative: number };
export type ExtractionCounts = Record<Dimension, Counts>;

export function emptyCounts(): ExtractionCounts {
  return Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, {
    truePositive: 0, falsePositive: 0, falseNegative: 0,
  }])) as ExtractionCounts;
}

const normalized = (text: string): string => text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

function factKey(text: string, evidence: Evidence[]): string {
  // Order is irrelevant, but every citation must match. Never discard a bad or
  // duplicate citation to improve the score. Production grounding runs first.
  return JSON.stringify([normalized(text), evidence.map(({ messageTs, permalink }) =>
    [messageTs, permalink]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

function atoms(analysis: Analysis): Record<Dimension, string[]> {
  return {
    decisions: analysis.decisions.map((fact) => factKey(fact.text, fact.evidence)),
    tasks: analysis.tasks.map((fact) => factKey(fact.text, fact.evidence)),
    owners: analysis.tasks.filter((task) => task.ownerSlackId !== null).map((task) =>
      JSON.stringify([factKey(task.text, task.evidence), task.ownerSlackId])),
    deadlines: analysis.tasks.filter((task) => task.deadlineText !== null).map((task) =>
      JSON.stringify([factKey(task.text, task.evidence), task.deadlineText])),
    blockers: analysis.blockers.map((fact) => factKey(fact.text, fact.evidence)),
  };
}

/** Micro counts over asserted values only. Null owners/dates never pad recall. */
export function scoreExtraction(expected: Analysis, actual?: Analysis): ExtractionCounts {
  const gold = atoms(expected);
  const observed = actual ? atoms(actual) : undefined;
  const scores = emptyCounts();
  for (const dimension of DIMENSIONS) {
    const remaining = new Map<string, number>();
    for (const key of gold[dimension]) remaining.set(key, (remaining.get(key) ?? 0) + 1);
    for (const key of observed?.[dimension] ?? []) {
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        scores[dimension].truePositive += 1;
        remaining.set(key, count - 1);
      } else {
        scores[dimension].falsePositive += 1;
      }
    }
    scores[dimension].falseNegative = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  }
  return scores;
}

export function addCounts(target: ExtractionCounts, addition: ExtractionCounts): void {
  for (const dimension of DIMENSIONS) {
    for (const key of ["truePositive", "falsePositive", "falseNegative"] as const) {
      target[dimension][key] += addition[dimension][key];
    }
  }
}

export function extractionMetric(byDimension: ExtractionCounts) {
  const total = DIMENSIONS.reduce((sum, dimension) => ({
    truePositive: sum.truePositive + byDimension[dimension].truePositive,
    falsePositive: sum.falsePositive + byDimension[dimension].falsePositive,
    falseNegative: sum.falseNegative + byDimension[dimension].falseNegative,
  }), { truePositive: 0, falsePositive: 0, falseNegative: 0 });
  const required = total.truePositive + total.falseNegative;
  const predicted = total.truePositive + total.falsePositive;
  return {
    byDimension,
    ...total,
    required,
    predicted,
    recall: required === 0 ? null : total.truePositive / required,
    precision: predicted === 0 ? null : total.truePositive / predicted,
    threshold: 0.9,
    // Decide with integer counts, never a rounded display percentage.
    recallCriterionMet: required > 0 && total.truePositive * 10 >= required * 9,
    noInventedValues: total.falsePositive === 0,
  };
}
