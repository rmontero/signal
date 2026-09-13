# A-08 synthetic evaluation

Owner: A-08, authorized GPT-6 Astra/max queued worker. Started 2026-09-13 15:26 UTC on `codex/signal-track-rob` in the shared checkout.

Scope: only `scripts/evaluate.ts`, `tests/evaluation/**`, `tests/unit/evaluation.test.ts`, and this report. The coordinator owns ledger/package wiring and shared interfaces. No agents spawned, branch changes, provider calls, database/Trigger work, package edits, staging, commits, pushes, or deployment.

Implementation and focused verification: **PASS**, ready for coordinator review. This is deterministic offline response replay through production validation/grounding, not an OpenRouter quality result. The verification-before-completion skill informed the fresh focused checks and separation of offline evidence from unrun provider checks.

## Changes

- `scripts/evaluate.ts`: runnable offline CLI, import-safe entry point, fixed error codes, explicit mode, aggregate-only JSON, exit 0/1/2 for pass/measured failure/configuration or harness error. Unknown arguments and `--live` fail closed. No env-file loading or output files.
- `tests/evaluation/fixtures.ts`: 34 independently authored synthetic scenarios and response test doubles. Covers decisions/tasks/owners/deadlines/blockers, ambiguity, injection, tenant evidence, targets, invalid schema, bot-only input and source overflow. Draft doubles use the candidate response, never gold labels.
- `tests/evaluation/annotations.ts`: separate human-authored reference assertions, outcomes, assignment and uncertainty requirements. E14 intentionally contains a required blocker missing from its response tape; it must remain a visible false negative.
- `tests/evaluation/harness.ts`: invokes the actual `FactExtractionSchema` and `analyzeThread`, thereby exercising production grounding, owner/deadline support, draft constraints, context/target validation and no-action handling. Repository/model/persistence dependencies are in-memory doubles only. Rejected cases must not persist; rejected positive cases retain their required-assertion denominator.
- `tests/evaluation/scoring.ts`: one-to-one, evidence-bound assertion scoring with independent owner/deadline counts, TP/FP/FN by dimension, micro recall/precision and an exact inclusive 90% threshold. Duplicates/extra assertions count as false positives; null fields and empty categories do not pad recall. Any false positive fails the overall gate even with recall above 90%.
- `tests/evaluation/README.md`: run commands, metric definition, coverage, evidence limitations and bounded future live-mode design.
- `tests/unit/evaluation.test.ts`: 24 focused tests, including actual rejection boundaries, intentional omission, exact-threshold rounding, label/response independence, hallucination/duplicate/evidence scoring, false no-action, cross-tenant stored proposal rejection, deterministic aggregates, no fetch calls, sanitized output, argument rejection and import safety.

## Measured evidence

The direct offline command returned `PASS`: **34/34 expected outcomes**, 18 accepted proposals in memory, 15 rejections, one no-action result, zero boundary/context mismatches, 17/17 assignment checks and 12/12 uncertainty checks. There were 46 model-double calls and six repository-double reads, with **zero provider requests**. Of 27 first-stage schema checks, 26 were valid and the malformed-response fixture was correctly rejected. Seven cases failed before any model-double call.

| Assertion dimension | TP | FP | FN |
|---|---:|---:|---:|
| Decisions | 4 | 0 | 0 |
| Tasks | 14 | 0 | 0 |
| Owners | 9 | 0 | 0 |
| Deadlines | 6 | 0 | 0 |
| Blockers | 2 | 0 | 1 |
| Total | 35 | 0 | 1 |

Required-assertion micro recall is **35/36 = 97.22%**, precision is **35/35 = 100%**, and the corpus-wide >=90% extraction criterion passes for these authored replay responses. The missed blocker is intentional. Blocker recall alone is 2/3; this is not a claim that every category exceeds 90%. Nineteen positive/no-action cases carry extraction references; fifteen negative cases test rejection behavior and do not count as successful extractions.

`modelQuality` remains `{status: "NOT_RUN", providerRequests: 0, recall: null, extractionCriterionMet: null}`. These response tapes are manually authored potential outputs, not recorded LLM completions. The measured replay recall is not an estimate of OpenRouter model quality and does not satisfy a live model release gate.

## Verification commands

Every command below used the explicit prefix `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH`; runtime was `v24.20.0`. Existing dependencies only, no env-file loading.

| Result | Command / evidence |
|---|---|
| PASS | `node --import tsx/esm scripts/evaluate.ts` — exit 0, aggregate results above |
| PASS | `npm run --silent test:eval` — coordinator's package wiring verified; exit 0 and the same 34-case aggregate |
| PASS | `node --import tsx/esm --test tests/unit/evaluation.test.ts` — 24 tests, 24 pass, 0 fail/skip; includes subprocess checks of CLI success and invalid/live arguments |
| PASS | `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --esModuleInterop --module ESNext --moduleResolution Bundler --target ES2022 --lib esnext,dom scripts/evaluate.ts tests/evaluation/annotations.ts tests/evaluation/fixtures.ts tests/evaluation/harness.ts tests/evaluation/scoring.ts tests/unit/evaluation.test.ts` — exit 0; focused files and imported service types only |
| PASS | `node node_modules/eslint/bin/eslint.js scripts/evaluate.ts tests/evaluation/*.ts tests/unit/evaluation.test.ts` — exit 0 |
| PASS | `git diff --no-index --check -- /dev/null <owned-file>` for all eight new owned files — no whitespace diagnostics; no-index difference exit 1 is expected for new files |
| NOT RUN | Full test suite, full project typecheck, build, DB/Trigger tests, migrations, real OpenRouter/Slack/GitHub smoke, browser/deployment acceptance and Mozilla.ai evaluation |
| NOT RUN | Independent fresh-context review; coordinator/existing reviewer owns acceptance. This worker did not spawn a reviewer |

## Findings and coordinator handoff

1. The original `test:eval` placeholder supplied no evaluation evidence. The requested npm script is `"test:eval": "node --import tsx/esm scripts/evaluate.ts"`, without env-file flags. At the 2026-09-13 16:08 UTC read-back, the coordinator-owned `package.json` already contained this exact command. This worker made no package/lock edits.
2. Update the coordinator-owned execution ledger and canonical verification documentation with **offline replay** evidence only. `docs/VERIFICATION.md` still described `test:eval` as an intentional NOT RUN placeholder when read for this task. Mozilla.ai/O-05 and live model quality remain unverified; this implementation adds no partner integration.
3. `analyzeThread` trusts the caller's complete, tenant-scoped source snapshot. Individual `SourceMessage` values carry no tenant/completeness metadata, so source pagination gaps and correctness of upstream tenant retrieval cannot be proved by this harness. Missing tenant IDs, foreign citations/targets, context preservation and cross-tenant cached proposals are tested. Real upstream retrieval and database isolation remain separate integration gates.
4. Quoted, schema-valid output can still misclassify a decision as a task or treat conversation as actionable. Focused tests demonstrate that production validation can accept those shapes while this scorer rejects their incorrect labels. Offline injection tapes test specified rejection/acceptance behavior; they do not measure whether the runtime model resists unseen injection.
5. Future live mode is design-only in the README: explicit live + synthetic-only opt-ins, fixed reviewed model via the existing OpenRouter adapter, serial execution, at most 38 requests for current positive/no-action cases, adapter timeouts/token caps, no repairs/retries, synthetic repository/persistence doubles, separate live metrics and unchanged denominators on failure. No live mode is implemented or invoked now.

No shared implementation, contract, DB, Trigger, or other worker files were edited. No task ledger update, stage/commit/push, provider mutation, or deployment was performed. The sole remaining ownership handoff is coordinator review/acceptance and canonical evidence recording.
