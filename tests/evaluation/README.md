# Synthetic analysis evaluation

Run under Node 24 with existing dependencies:

```sh
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx/esm scripts/evaluate.ts
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx/esm --test tests/unit/evaluation.test.ts
```

Coordinator package wiring: `"test:eval": "node --import tsx/esm scripts/evaluate.ts"`. No env file is needed. Default and `--offline` are equivalent. Other arguments, including `--live`, return exit 2. Exit 0 means the offline gates passed; exit 1 means a measured gate failed. Configuration/unexpected harness errors return exit 2 with a fixed safe code. The CLI prints exactly one aggregate JSON record and writes no files.

## What is being measured

This is **deterministic offline response replay**, not LLM inference and not a Mozilla.ai integration. `fixtures.ts` contains 34 authored synthetic conversations and independent response test doubles. `annotations.ts` contains separately authored reference labels and rejection expectations. Responses never read those labels. The harness injects only in-memory model, repository, and persistence doubles into the actual `analyzeThread` service. It uses the actual `FactExtractionSchema` and the production evidence, owner, deadline, draft, context, and target validators. Draft doubles use the response being tested, not the expected labels. No client, provider, database, or Trigger connection is created.

The metric scores **actual validated service output**. E14 deliberately misses one blocker: this must appear as a false negative. Replay responses are authored examples of potential output, not recordings of a model run, and not estimates of how often a model will succeed. Changing references cannot change the response under evaluation; tests verify this separation.

## The 90 percent criterion

Each decision, task, or blocker is one required assertion. Each non-null owner and deadline is an additional assertion tied to that same task and evidence. Nulls and empty categories contribute no true positives. This prevents absent values from inflating extraction quality. Required facts come only from positive and no-action reference cases; rejection cases have a boundary oracle rather than a fabricated extraction reference.

An assertion matches only when its category, normalized quoted text, and full set of source timestamp/permalink pairs match. Text normalization only handles NFC, case, and whitespace. Owner IDs and deadline wording match exactly. Evidence ordering is immaterial; missing, extra, duplicate, and foreign citations do not disappear during scoring. Matching is one-to-one, so a repeated prediction contributes a false positive. An owner/date on the wrong task receives no credit. Missing output or a rejected positive fixture contributes false negatives for every required assertion.

Micro recall is `TP / (TP + FN)`. The inclusive 90% gate is computed as `10 * TP >= 9 * (TP + FN)` without rounding, with at least one required assertion. Per-dimension TP/FP/FN counts and micro precision `TP / (TP + FP)` are also reported. The overall offline result requires recall >=90%, **zero false positives**, all expected outcomes, no persistence on rejection/no-action, at most two model-double calls per case, preserved context, all assignment/required-uncertainty checks, and all coverage categories. The 90% criterion is corpus-wide; it does not imply every dimension exceeds 90%.

No-action cases still fail on unexpected actionable assertions. Exact required uncertainty phrases are checked separately; arbitrary uncertainty prose is not counted in the extraction metric or certified as grounded. Schema-invalid and grounding-invalid negative responses must be rejected by the production service before persistence. A correct rejection is boundary evidence, not a successful extraction.

`modelQuality.status` is always `NOT_RUN`, `providerRequests` is zero, and its recall/criterion fields are null. An offline `PASS` does not satisfy a live OpenRouter quality gate. The response replay metric cannot establish generalization, semantic classification quality, or prompt-injection resistance of a model.

## Coverage and limitations

The cases cover decisions, tasks, first-person/explicit/missing/ambiguous/unmapped owners, timezone and unresolved deadlines, blockers, mixed facts, deliberate omission, no-action, harmless handling of an injection-shaped source, rejected invented facts/draft prose, schema errors, absent and foreign evidence, missing tenant context, a second synthetic tenant, progress comments, multiple related candidates, no related results, ambiguous targets, PR targets, closed/transferred targets, repository unavailability, bot-only input, and 51-message overflow. Unit coverage additionally checks a correctly formed proposal restored across tenants, scorer failure modes, safe output, and no network usage.

The service trusts its caller to have loaded the correct tenant's complete snapshot. Source provenance and pagination gaps are enforced upstream and cannot be demonstrated by `analyzeThread`, which has no completeness/tenant field on individual `SourceMessage` values. These checks do not prove database isolation, Slack retrieval completeness, live GitHub permissions, approval/execution, or provider quality. Those remain the coordinator's integration/release checks. This corpus therefore does not claim the entire canonical release matrix is complete.

## Future live mode (design only; not implemented or run)

A separately authorized command can use the existing `createOpenRouterClient` adapter in the model slot of `analyzeThread`, retaining the synthetic GitHub/persistence doubles and separate annotations. Restrict it to reviewed, sanitized positive/no-action synthetic conversations; negative response-tape fixtures remain offline because they prescribe malicious/malformed model outputs. Require explicit live + synthetic-only opt-ins and a fixed model, use the existing adapter's timeouts/token caps and no retries, run serially, and cap the run at two calls per selected case (currently at most 38). Do not load arbitrary files or enable provider selection via a fixture.

For that mode, keep attempted model calls, successful schema responses, provider failures, extraction output counts, and metadata distinct from offline results. Failed or rejected positive cases retain their required-assertion denominator; never omit them to improve recall. Score only captured validated outputs against unchanged reviewed labels. Persist only aggregate counts and safe version metadata. Any output review beyond aggregates would need its own explicitly authorized handling. Offline tapes and the hand-authored wording make a small regression corpus, not a representative or blinded model benchmark.
