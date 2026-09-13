# A-03 approval service safety

Owner: A-03 / Bohr. Scope: `src/services/approve.ts`, `src/services/slack-interactions.ts`, their two focused test files, and this report. Started 2026-09-12 22:52 UTC. Service implementation and focused verification: PASS. End-to-end approval safety: PARTIAL until coordinator persistence/route integration and independent review.

## Changes

- `src/services/approve.ts`: current named-actor checks for Review, review recording, Dismiss and Approve; exact raw identifier validation; scoped proposal-ID validation; finite dates and expiry checks after asynchronous authorization; exact immutable SHA-256 verification without normalization; revalidation of displayed review content after Slack assigns the modal ID; sanitized persistence errors; accepted modal-aware approval dependency and exact replay handling.
- `src/services/slack-interactions.ts`: reject contradictory team/channel/actor hints, normalized or cross-tenant metadata, injected metadata fields, and duplicate form payloads; match both prepared review identity and private metadata before opening a modal; sanitize dependency failures; accepted optional private-notice hook; submit denial replaces the view with a static notice without approval controls, while success explicitly clears it. A consumed trigger is not reused after review recording fails.
- `tests/approval.test.ts`: 58 synthetic approval tests covering unauthorized review/dismiss, revoked policy or supersession while opening a modal, exact modal/actor/team/channel/version/hash/expiry/operation bindings, changed repository/comment target/assignee/content, exact-byte hashing, invalid clocks, delayed expiry, replay, safe errors and positive create/comment paths.
- `tests/slack-interactions.test.ts`: 31 synthetic interaction tests covering parsing/context failures, prepared-review isolation, actor authority, redacted failures, private notices and acknowledgment semantics.
- `docs/reviews/astra-03.md`: this handoff and pre-implementation DB request. No competing execution ledger.

## Accepted interfaces and route integration

The coordinator explicitly accepted both additive interfaces before implementation:

```ts
// src/services/approve.ts
interface ApprovalRequest extends ApprovalBinding { modalId: string }
// ApprovalDependencies.approve:
(binding: ApprovalRequest) => Promise<{ approvalId: string; jobId: string }>

type ApprovalNoticeModal = Pick<ApprovalModal, "type" | "title" | "close" | "blocks">;

// src/services/slack-interactions.ts / SlackInteractionDependencies
openNotice?: (input: {
  triggerId: string;
  modal: ApprovalNoticeModal;
}) => Promise<void>;
```

The route forwards the exact validated binding plus `modalId`; the DB must parse the strict canonical binding separately from that modal field. A submission for an already APPROVED proposal may retrieve the original approval/job, including after the original expiry; only the atomic repository decides whether the replay matches the original actor, modal and binding. It must never create a fresh approval/job on this path. Current named-actor checks still apply in the service.

The coordinator/A-09 must wire `openNotice` to `views.open` through the Slack adapter. Its `modal` intentionally contains no `submit`, approval callback or private metadata. Without the hook the handler returns a sanitized 200 denial, which does not itself display a notice in Slack. The existing approval `openModal` signature is unchanged. Dismissal needs this repository input (already supplied by the service):

```ts
{ tenantId: string; proposalId: string; version: number;
  slackTeamId: string; channelId: string; actorSlackId: string }
```

Slack requires view-submission errors to address an input block; this read-only review has none, so submit denial uses a view update. Button-action notices require a modal API call; a successful submit uses `response_action: "clear"`. These choices follow the [Slack modal response documentation](https://docs.slack.dev/surfaces/modals/) and [interaction acknowledgment documentation](https://docs.slack.dev/interactivity/handling-user-interaction/). Only public documentation was read; no provider content or live Slack calls were used.

## Repository requirements sent before service call changes

At the initial A-03 inspection, `approveProposal` checked the proposal ID, operation, version, stored hash, pending state and DB expiry, but did not atomically validate the review, actor, team/channel, exact submitted expiry, tenant activity or current repository mapping. `claimMutation` only checked READY and existence of an approval. Service prechecks alone cannot close these races. The coordinator is editing the DB concurrently; this section records the original request, not an audit of that unfinished correction.

Coordinator integration request A03-DB-01:

1. Add modal identity to the approval persistence input without changing the canonical `ApprovalBinding`: propose accepting `ApprovalBinding & { modalId: string }` through the service dependency and repository. The route already forwards the dependency input. Validate modal identity separately before parsing the strict canonical binding. Reject missing modal identity at the persistence boundary.
2. In the row-locked approval transaction, bind the tenant/proposal/operation/thread relationships; match the persisted modal ID, actor, team, channel and version; require an active tenant with the same Slack team, an enabled non-shared channel mapping, and the currently enabled named actor. Compare submitted expiry exactly to persisted expiry and use database time to reject expiration. Recompute the exact canonical hash over the immutable mutation (without normalization), including the operation marker, repository ID/owner/name, issue identity and assignee. Compare current mapping repository identity to the immutable target and verify the active thread operation before the state transition.
3. Serialize those policy/mapping checks against configuration changes with row locks or a transactionally maintained configuration version. The existing `tenants.configVersion` must be advanced by configuration writers if used as the fence. Claim must compare the config version captured for target preflight, recheck tenant/team/channel/approver and immutable approval/proposal/target binding under the same transaction, and only then transition READY to SENDING. External target reads stay outside transactions; remote target changes after preflight remain subject to returned-identity verification.
4. An exact replay must return the recorded approval and original execution job, never insert another job or grant authority to a different actor/binding/modal. The coordinator accepted the modal-aware atomic approval/replay dependency. Service forwarding now implements it; repository integration must additionally distinguish two separately opened matching modals and accept only the modal bound to the original approval.
5. `dismissProposal` already receives actor/team/channel from the service, but its repository signature discards them. Require those exact values, current named-actor/config/mapping checks, pending version and DB expiry in the dismiss transaction. Atomically mark the unused operation STALE and clear its matching thread `activeOperationId`. Recheck pending state, version, actor and context when recording a Slack-assigned modal after `views.open`.
6. `loadProposalForApproval` parses and may normalize persisted mutation fields before returning them. Preserve immutable bytes after validating, or reject normalization changes, so the service/executor cannot approve a cleaned representation of corrupted stored material.

DB, route, contract and configuration files remain coordinator-owned. The initial request was delivered before changing service calls; accepted interface changes were then implemented only in owned files.

## Verification

All checks used existing dependencies and Node 24.20.0, with no environment-file loading or provider access.

- PASS — `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx/esm --test tests/approval.test.ts tests/slack-interactions.test.ts`: 89 tests, 89 passed, 0 failed/skipped. Baseline was 11/11; targeted new regression cases were observed failing before the relevant fixes. Later binding-boundary coverage also exercises previously correct behavior.
- PASS — `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck src/services/approve.ts src/services/slack-interactions.ts tests/approval.test.ts tests/slack-interactions.test.ts`.
- PASS — `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node node_modules/eslint/bin/eslint.js src/services/approve.ts src/services/slack-interactions.ts tests/approval.test.ts tests/slack-interactions.test.ts`.
- PASS — `git diff --check -- src/services/approve.ts src/services/slack-interactions.ts tests/approval.test.ts tests/slack-interactions.test.ts docs/reviews/astra-03.md`.
- NOT RUN — full suite, build, real DB concurrency/replay checks, migrations, provider reads/writes and deployed Slack behavior. These are outside worker scope; unit doubles do not prove atomicity, Slack timing, signature verification, or external integration.
- NOT RUN — independent critical-path review; requested from the coordinator for the final owned diff. No additional agents spawned.

Remaining integration needs: A03-DB-01 transaction/config/mapping/replay checks; the accepted `openNotice` route/adapter wiring; preservation of raw persisted mutation bytes in repository loaders; signed-ingress checks and no browser approval route; independent review plus coordinator integration tests. Shared-checkout changes by other workers were preserved. No branches changed, files staged, commits, pushes, migrations, deployments, messages to workplace users or GitHub mutations were performed.

## Requested independent schema and migration review

Read-only review of the coordinator's in-progress `src/db/schema.ts`, `0005_swift_iceman.sql`, `0006_fat_masque.sql`, corrected `0001_white_epoch.sql`, earlier referenced migration constraints and the relevant pilot-config writer. No DB queries or migrations were executed. The coordinator's statement that the existing real approver count is zero was not independently verified.

Concrete concerns sent directly to the coordinator:

1. **A03-SCHEMA-01 — modal relationship is not enforced by the new schema.** `src/db/schema.ts:79` and `src/db/migrations/0006_fat_masque.sql:3` add nullable `approvals.modal_id`; the approval constraints also omit a FK to `slack_reviews(tenant_id, proposal_id, modal_id)`. The DB therefore permits an approval with no persisted review or with an unrelated/nonexistent modal. Add the tenant/proposal/modal composite FK and require a non-null modal for new authorizations; if legacy rows must remain nullable, explicitly quarantine them and reject them in both claim and replay. The service now requires a modal, but this does not itself enforce the database contract. Repository enforcement is being changed concurrently and was not assumed complete.
2. **A03-CONFIG-01 — concurrent imports can reuse an authorization config version.** `scripts/import-pilot.ts:12` reads the current version without a row lock, computes `N + 1`, then supplies that literal to the upsert at line 14. Two concurrent transactions can read N and publish different policy/mapping configurations with the same N+1, defeating a preflight/claim comparison of that version. Serialize imports by tenant or atomically increment the existing tenant version in the upsert and use its returned value before writing mappings/approvers. An initial-tenant insert race also needs to use the actual conflicting row's increment rather than a precomputed literal. This is a concrete writer issue, not a complaint about transient lifecycle types.

Verified by inspection:

- The approver PK is `(tenant_id, channel_id, slack_user_id)` and its mapping FK is `(tenant_id, channel_id)`. Both include tenant scope and require an existing configured channel. Pilot import inserts the actual configured channel, updates the full composite conflict target, and disables previous grants before enabling the provided grants.
- Corrected 0001 creates `operations_identity_unique(tenant_id, id, proposal_id)` before creating the referencing approval FK. It closes the fresh-bootstrap ordering defect without weakening the tenant/operation/proposal relationship.
- 0006 adds approver `channel_id NOT NULL` without a default or guessed backfill, so populated unscoped grants deliberately fail. The installed Drizzle PG migrator wraps pending migrations in a transaction; the coordinator's isolated migration-check script also wraps each migration. Under these paths, an intentional failure rolls back the preceding PK/index drops. No migration runtime success is claimed here.
- The PENDING-only proposal index permits historical APPROVED proposals to remain terminal while later versions are created. This still requires the coordinator's locked active-operation checks to prevent a new write while an earlier operation is approved/unresolved; the index alone cannot enforce that cross-table invariant.
- 0005/0006 column names, defaults, new notification-state check, approver constraints and thread/version uniqueness align with the current schema declarations by inspection.

Upgrade caveats: 0006's new `(tenant_id, thread_id, version)` uniqueness can also fail on historical duplicate versions even when there are zero approvers. The coordinator should check count/ID-only evidence before migration; never renumber immutable versions/hashes silently. Existing proposals receive config version 1 in 0005; do not treat this backfill as proof of a legacy draft's original configuration, and capture the current locked version on every new draft. Correcting an already-journaled 0001 file does not cause Drizzle to rerun it, so an existing installation needs separate constraint verification. These are conditional upgrade checks, not assertions about live data.

Schema review result: PARTIAL — two concrete concerns handed to the coordinator; local inspection only, with no edits outside A-03's owned files.

Final coordinator response: both findings accepted. The coordinator reports `approvals.modalId` is now NOT NULL with a composite FK to `slack_reviews` (follow-up migration generation pending), and pilot import now increments `tenants.configVersion` atomically using `ON CONFLICT UPDATE RETURNING`, retaining the tenant row lock through configuration updates. Those latest corrections were not independently reread or migration-tested by A-03; the coordinator requested immediate handoff to free the worker slot. A-10 / Dirac has started independent reviews. A-03's final focused rerun still passed all 89 tests and the owned diff check. No A-03 implementation work remains; shared integration, new migration verification and independent review remain with the coordinator/A-10.
