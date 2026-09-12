# I-06 recovery review

Review status: **PASS for scoped correction rereview**

Reviewer: Luna, fresh context, 2026-09-12. Scope was limited to the correction
deltas and the requested repositories, adapters, task wiring, and tests. No
provider calls, messages, mutations, commits, or source edits were performed by
this review. Only this report was edited.

## Correction rereview

### RESOLVED — Live GitHub repository identity check

`src/trigger/tasks.ts:173-178` first requires the tenant mapping and then calls
the GitHub read adapter. It returns a repository only when the live provider ID
equals the mapped ID. The adapter also validates the live owner/name at
`src/adapters/github-read.ts:224-233`, and the service retains the final exact
comparison at `src/services/reconcile.ts:90-94`.

This closes the same-coordinate delete/recreate path identified in the prior
review. No remaining concrete bug was found in this correction.

### RESOLVED — Exact recorded Trigger owner

`src/db/repositories.ts:368-378` now requires one persisted execution outbox row,
a non-null run ID, and exact equality with the operation attempt. It no longer
synthesizes a run ID or accepts a legacy job ID. The executor records
`ctx.run.id` before mutation claim at `src/trigger/tasks.ts:132-140`, while
`src/db/repositories.ts:141-143` prevents dispatch acknowledgment from replacing
an existing different run.

The new integration coverage at `tests/integration/persistence.test.ts:367-378`
checks missing, synthesized, legacy-job, and conflicting-run cases. No remaining
concrete bug was found in this correction.

### RESOLVED — Fenced unresolved notes

`src/db/repositories.ts:401-404` now conditions note updates on tenant,
operation, `UNKNOWN` state, owner attempt, and fencing token, and throws
`PersistenceConflict` when no row is authorized. `src/services/reconcile.ts:63-85`
binds the note to the loaded owner/fence and leaves note writes disabled for
`SENDING` until the fenced transition succeeds. The coverage at
`tests/integration/persistence.test.ts:380-390` checks wrong owner, wrong fence,
and completed-result cases. No remaining concrete bug was found in this
correction.

## Verified correction areas

- **PASS, service gate:** `src/services/reconcile.ts:61-82` requires an expired
  lease and a confirmed terminal owner before transitioning `SENDING` or reading
  back `UNKNOWN`; active leases and unconfirmed owners perform no provider read.
- **PASS, marker safety:** `src/services/reconcile.ts:39-45,104-119` rejects
  missing, multiple, altered, wrong-author, and wrong-target matches; it never
  posts a replacement mutation.
- **PASS, comment parent identity:** `src/adapters/github-read.ts:154-165,284-290`
  validates the parent issue and canonical comment identity before returning
  reconciliation records.
- **PASS, fenced outcomes and atomic delivery:**
  `src/db/repositories.ts:263-271,313-338,357-365` fences result transitions and
  keeps thread binding plus Slack notification enqueue in the same transaction.
- **PASS, duplicate-safe recovery enqueue:**
  `src/db/repositories.ts:385-395` locks the operation, checks for an existing
  reconciliation job within the tenant, and inserts at most one recovery job.

## Verification

- **REPORTED PASS, not independently rerun:** the coordinator reports the full
  earlier suite at 94/94, plus Node 24 build, typecheck, and lint passing.
- **NOT RUN:** database tests in this rereview. The prior interrupted run may
  have left fixture tenants; cleanup belongs to the coordinator.
- **NOT RUN:** live Trigger status, Slack, GitHub, replay, or mutation checks.

## Remaining pre-existing I-05/I-06 work

Live signed delivery, real Trigger/provider acceptance, GitHub create/comment
replay, production authorization, and the future outbox lifecycle/retry sweep
remain openly incomplete I-05/I-06 work. They are not new findings against these
corrections and remain `NOT RUN` or incomplete in the project ledger.
