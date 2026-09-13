import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateCorpus } from "../tests/evaluation/harness";

export async function evaluateCli(args: string[]) {
  const failure = (errorCode: "evaluation_invalid_arguments" | "evaluation_failed") => ({
    exitCode: 2,
    summary: {
      schemaVersion: 1, mode: "deterministic_offline_response_replay", status: "FAIL", errorCode,
      modelQuality: { status: "NOT_RUN", providerRequests: 0, recall: null, extractionCriterionMet: null },
    },
  });
  // No environment loading, file inputs, result payloads, or implicit live mode.
  if (args.length > 1 || (args.length === 1 && args[0] !== "--offline")) return failure("evaluation_invalid_arguments");
  try {
    const summary = await evaluateCorpus();
    return { exitCode: summary.status === "PASS" ? 0 : 1, summary };
  } catch {
    // Never serialize exception text, prompts, fixtures, responses, or stacks.
    return failure("evaluation_failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { exitCode, summary } = await evaluateCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCode;
}
