# A-05 — Mutation services and result delivery

Owner: A-05 / Kuhn. Branch: `codex/signal-track-rob`, shared checkout. Review prepared 2026-09-12 23:00 UTC.

Status: service implementation and focused verification PASS; coordinator integration and independent review remain required. No real provider access, database operations, commits, staging, pushes, deployments, branch changes, or additional agents were used.

## Changed files

- `src/services/execute.ts`
- `src/services/reconcile.ts`
- `src/services/notify.ts`
- `tests/execution.test.ts`
- `tests/recovery.test.ts`
- `docs/reviews/astra-05.md`

Other workers' changes were preserved. No shared contracts, database files, Trigger files, package files, lockfiles, or execution ledger were edited.

## Corrections

Execution hashes the exact persisted canonical JSON bytes and requires one exact operation marker. The shared `payloadHash` helper calls `prepareMutation` and is appropriate for creation; using it again after approval concealed whitespace/marker changes. The executor also rejects invalid/expired approval timestamps, rechecks approval after target reads, validates the parent issue's exact URL, and validates canonical returned numeric IDs and issue/comment URLs. A comment result must contain the matching `#issuecomment-ID` on the approved parent.

Each POST receives the existing adapter's optional `signal`, with a deadline capped at 30 seconds and the remaining operation lease. No HTTP retry or second POST was added. The claim remains the exclusive `READY → SENDING` gate; duplicate calls during `SENDING` and after `UNKNOWN` perform no further POST. Deadline outcomes retain the original attempt/fencing token. Success persistence is outside provider-outcome classification: an exception or lost success fence raises a sanitized persistence error, without misclassifying a completed POST as a definitive rejection or clearing its owner.

Reconciliation applies the same immutable-byte/marker check, validates returned IDs, exact repository/parent/body/title/expected App author, and retains the expired-lease plus confirmed-terminal-owner requirement before provider reads. Failure to transition the original `SENDING` fence prevents read-back. Missing, multiple, changed, or incomplete matches stay `UNKNOWN`; this service has no mutation client. Success persistence errors expose only a fixed error code.

Both success paths carry observed `actualAssignees` and `assigneeMismatch`. Login comparison is case insensitive, while the actual returned values are preserved. A dropped or different assignee is reported on the successful creation; it never causes PATCH or another creation. Missing assignee evidence remains absent, not an empty assignment.

Result delivery accepts the coordinator-approved complete optional context on both arguments. Once either argument supplies context, both must match tenant, operation, proposal, channel, and message timestamp, and the actual update destination must match. Retries update the same existing message. The Slack call explicitly contains only `channelId`, `messageTs`, and rendered `text`; extra input fields and context never reach transport. Rendering reports actual assignment/mismatch, maps recognized error codes to fixed recovery prose, and excludes arbitrary error strings, resolution text, and unsafe URLs. Missing assignment evidence renders as unavailable.

## Accepted additive interfaces and integration needs

These requirements were sent to main during the signature audit and explicitly accepted before implementation:

1. Execution and reconciliation success callback inputs/results: `actualAssignees?: string[]`, `assigneeMismatch?: boolean`. Main owns persistence through `operations.resultAssignees` and nullable `operations.assigneeMismatch`, transaction atomicity, and notification outbox creation. The schema fields exist in the shared checkout; this worker did not run migrations or database checks.
2. Reconciliation records: `assignees?: string[]`. Main coordinates A-01's GitHub read adapter. Absent evidence must stay absent; do not default it to `[]`.
3. `ResultNotification.context?: NotificationContext` and `NotificationOperation.context?: NotificationContext`, where `NotificationContext` is `{ tenantId, operationId, proposalId, channelId, messageTs }`. Main must load the destination from the exact persisted proposal and supply both contexts using the notification job's operation identity. Existing callers omitting both retain interface compatibility, so the cross-owner wiring is required to enable binding enforcement in production.
4. `NotificationOperation` accepts nullable optional `actualAssignees` and `assigneeMismatch` for database read compatibility. Main owns `loadNotificationContext`, all task lifecycle transitions, destination persistence, stale notification recovery, and serialization.
5. Main accepted exact canonical hashing in repository validators; the creation-only `payloadHash` helper must not normalize persisted approved material.

Adapter limits: the current write adapter returns only `{id, number, url, assignees}` for issues and `{id, url}` for comments. Direct response validation therefore proves the returned identity/parent and the exact bytes sent, not an independently returned body or author. Reconciliation provides the full stored-body/title/marker/App-author read-back. No new adapter requirement or mandatory provider read was invented in this worker's files.

## Verification

All commands used Node 24 via `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH`, with existing dependencies and no environment-file loading.

| Status | Evidence |
|---|---|
| PASS | Baseline focused suite: 19 tests passed before changes. |
| PASS | Execution regression cycle: 9 new failures reproduced before corrections; final execution suite 18/18 passed. |
| PASS | Recovery/notification regression cycle: 10 new failures reproduced before corrections; final recovery suite 23/23 passed. |
| PASS | `node --import tsx/esm --test tests/execution.test.ts tests/recovery.test.ts` — 41 tests, 41 passed, zero failed/skipped/cancelled. |
| PASS | `./node_modules/.bin/eslint src/services/execute.ts src/services/reconcile.ts src/services/notify.ts tests/execution.test.ts tests/recovery.test.ts` — exit 0. |
| PASS | `./node_modules/.bin/tsc --noEmit --target ES2017 --module ESNext --moduleResolution bundler --strict --skipLibCheck --allowImportingTsExtensions --esModuleInterop --lib dom,esnext src/services/execute.ts src/services/reconcile.ts src/services/notify.ts` — exit 0; scoped service compilation only. |
| PASS | `git diff --check -- src/services/execute.ts src/services/reconcile.ts src/services/notify.ts tests/execution.test.ts tests/recovery.test.ts docs/reviews/astra-05.md` — no whitespace errors. |
| PARTIAL | Production persistence, exact-proposal notification destination, and A-01 assignment read-back wiring belong to main; their integration has not been verified by this worker. |
| NOT RUN | Independent fresh-context review; route to the existing coordinator/reviewer, without spawning another agent. |
| NOT RUN | Full suite, full typecheck, build, migration, real Slack/GitHub/provider smoke tests, or deployment, per worker scope. |

The focused failure tests cover wrong or malformed result identities, parent mismatch, immutable bytes and duplicate/foreign markers, expiry after reads, assigned-user mismatch, lost persistence authority, concurrent execution/replay, deadline abort, active/nonterminal recovery owners, missing/ambiguous markers, incomplete reads, and cross-operation/proposal/tenant notification context. External interactions are dependency-injected synthetic fixtures only.

The systematic-debugging, test-driven-development, and verification-before-completion skills informed the boundary audit and failing-regression-first verification. No skill expanded the authorized scope or required a pause.
