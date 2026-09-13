# A-09 — Signed ingress and security regression report

Date: 2026-09-13. Owner: A-09 / queued Astra worker. Scope: the assigned API routes, five unit-test files, and this report. Shared checkout: `codex/signal-track-rob`; HEAD observed at handoff: `b359d1d9bb36bcf5123ec2913f7e48dd1f4cee89`.

Status: **PASS** for the focused mocked route checks; **PARTIAL** for the overall ingress security gate pending the coordinator-owned findings below and independent review. No other worker was spawned. No ledger, shared contract, dependency, database, Trigger, domain, adapter, or other worker file was edited. No staging, commit, push, migration, deployment, live delivery, provider message, or model call was performed. Private environment files were not read and no secret values were printed.

## Changes and evidence

- Replaced lossy `request.text()` authentication with bounded raw-byte intake and native SHA-256 HMAC / `timingSafeEqual` verification before UTF-8, JSON, or form decoding. Slack retains its five-minute past/future timestamp window. Invalid UTF-8 authenticated as its replacement character previously returned 202 on GitHub; the regression now returns 401. Correctly signed invalid UTF-8 and invalid JSON return 400. BOM stripping cannot validate a signature for different bytes.
- Invalid signatures return 401 before parsing or persistence. Signed non-object envelopes, invalid challenges, malformed supported events, and malformed interaction forms fail with 400. GitHub errors now follow `{error:{code,requestId}}`. GitHub full names with extra path components are rejected. Unsupported/bot events and Slack shared channels, DMs/group DMs, bot/app messages and message subtypes do not enter persistence.
- Intake uses only the tenant returned by the server resolver; absent, blank, or whitespace-altered tenant results cannot reach acceptance. Client tenant fields are ignored. Observer persistence receives only coordinates and the exact body hash; dispatch receives the existing tenant/job/task/schema identifiers.
- The three signed routes have one 2,500 ms foreground budget, including body intake. Event bodies are capped at 1 MiB; interaction forms at the existing 64 KiB limit. Excess bodies return 413; stalled reads or dependencies return sanitized 503. Tests verify stream cancellation, no later insert after a timed-out tenant lookup, and no late dispatch after a timed-out acceptance.
- All successful event acknowledgments still await `acceptMention` / `acceptObserverEvent`; successful modal approval still awaits the approval service/repository result. A missing job ID is unavailable, including on a duplicate result. The shared `dispatchStoredOutboxJob(db, input)` contract is unchanged. Dispatch and pool drain now run through Next.js `after` after the response; dispatch, pool-close, or callback-registration failures cannot overwrite committed acceptance. Missed dispatch remains the durable recovery service's responsibility. There are no synchronous model calls.
- Wired accepted `openNotice({triggerId,modal})` to `createSlackApiClient.openModal`; unauthorized review opens a modal with no approval controls. The route passes the request deadline's abort signal to the Slack adapter. It forwards the canonical binding plus `modalId` unchanged to `approveProposal`. Tests run the real interaction/approval services against mocked persistence and modal transport, including wrong tenant, actor, modal, version, hash, expiry, persistence failure and replay. Unrecorded or late-opened modals cannot complete review.
- Maintenance compares fixed-size SHA-256 digests with `timingSafeEqual`, requires one exact bearer credential, rejects missing/blank/padded server secrets, and returns no-store sanitized errors. Its foreground response has a 10,000 ms budget; counts are explicitly selected and validated before returning them. Unexpected dependency fields are not spread into responses. Health liveness remains exactly `{status:"ok"}`.
- Added pure adapter/domain/config checks for signature formats, malformed GitHub identities, exact hashes, missing tenant/event identity, unknown authority fields, missing channel mapping coordinates, and no implicit Auth0 tenant mapping.

The route factories take typed dependencies so the same handler bodies can be exercised without a database, provider traffic, module-loader flags, or package changes. Concrete `route.ts` files wire the existing shared functions and Next.js `after`. Installed Next.js 16.3.5 route-handler and `after` documentation was read before implementing this change.

## Changed files

- `src/app/api/_lib/ingress.ts` (new): byte authentication, request budget, sanitized errors, post-response dispatch/cleanup.
- `src/app/api/slack/events/{route,handler}.ts` (`handler.ts` new).
- `src/app/api/github/webhooks/{route,handler}.ts` (`handler.ts` new).
- `src/app/api/slack/interactions/{route,handler}.ts` (`handler.ts` new).
- `src/app/api/internal/maintenance/{route,handler}.ts` (`handler.ts` new).
- `tests/unit/observer-routes.test.ts`.
- `tests/unit/observer-events.test.ts`.
- `tests/unit/github-webhook.test.ts`.
- `tests/unit/maintenance-routes.test.ts`.
- `tests/unit/pilot-config.test.ts`.
- `docs/reviews/astra-09.md`.

`src/app/healthz/route.ts` was inspected and tested without modification.

## Verification

Run from `/Users/robcr/Projects/signal`, using existing dependencies and Node 24.20.0. Environment files are intentionally not loaded by the focused test command. All signed delivery bodies, secrets, persistence outcomes, and provider behavior in these tests are synthetic.

**PASS — 52 tests, 0 failures, 0 skips/TODOs**, exit 0:

```sh
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx/esm --test tests/unit/observer-routes.test.ts tests/unit/observer-events.test.ts tests/unit/github-webhook.test.ts tests/unit/maintenance-routes.test.ts tests/unit/pilot-config.test.ts
```

**PASS — no lint errors or warnings**, exit 0:

```sh
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node node_modules/eslint/bin/eslint.js src/app/api src/app/healthz/route.ts tests/unit/observer-routes.test.ts tests/unit/observer-events.test.ts tests/unit/github-webhook.test.ts tests/unit/maintenance-routes.test.ts tests/unit/pilot-config.test.ts
```

**PASS — tracked diff whitespace check**, exit 0:

```sh
git diff --check -- src/app/api src/app/healthz/route.ts tests/unit/observer-routes.test.ts tests/unit/observer-events.test.ts tests/unit/github-webhook.test.ts tests/unit/maintenance-routes.test.ts tests/unit/pilot-config.test.ts docs/reviews/astra-09.md
```

Initial targeted regression run: **FAIL as expected**, 1 pass / 5 failures: GitHub error schema, signed non-object Slack JSON throwing, malformed interactions requiring a database, unsanitized database setup failure, and lossy-byte signature acceptance. Those tests all pass after the changes. A subsequent malformed app-mention regression exposed classification fallback incorrectly returning 202; that correction is included and verified.

**NOT RUN:** full test suite, global typecheck/build, migrations, database integration/concurrency tests, Next.js deployed `after` lifecycle, provider registration/delivery, Trigger dispatch, model calls, real Slack modal/approval, GitHub writes/replay, and independent review. These are coordinator-owned. Verification-before-completion guidance was used to keep reported results tied to actual commands.

## Coordinator follow-ups — no edits made to shared files

1. **A09-DB-01 — GitHub tenant ambiguity can be hidden by the query limit (high).** At the final inspection, `resolveGitHubObserverTenant` in `src/db/repositories.ts` selects up to 100 mapping rows, then constructs the distinct tenant set in JavaScript. If one tenant owns the first 100 matching channel mappings and a second tenant owns another matching mapping, the function can return the first tenant. Required correction: query distinct tenant IDs before limiting to two; return null unless exactly one remains. Also review exclusion of mappings marked shared, which the Slack resolver already enforces. Required verification: ambiguity after many same-tenant mappings, disabled tenant/mapping, and shared-only mapping. Route mocks confirm the response to a null resolver result, not correctness of this query.
2. **A09-DB-02 — Configuration revocation between lookup and acceptance (high).** `acceptMention` and `acceptObserverEvent` insert their inbox/event and outbox rows atomically, but do not recheck the active tenant and exact enabled/non-shared mapping inside that transaction. A mapping or tenant disabled after the separate route lookup can still admit the event. Required correction: transactionally revalidate the Slack team/channel or GitHub repository/installation mapping and active tenant before insert; preserve the current return contracts and original-job replay behavior. Required verification: pause after route resolution, revoke mapping/tenant, then attempt acceptance; no accepted event/job should commit. These are code-review findings; database execution was not performed.
3. **A09-RUNTIME-01 — HTTP deadlines are not database or recovery cancellation (medium).** The new foreground budget rejects a stalled call and prevents later route steps, but an already-started database transaction can still commit, and shared `recoverOutbox` does not take a cancellation/budget parameter. Its current 45-second check covers only its first recovery loop, not all subsequent database/dispatch loops. The route returns 503, never a false success, on timeout; a late accepted job is left for durable recovery. Coordinator should apply appropriate transaction statement/lock timeouts and, if strict end-to-end cancellation is required, an accepted additive budget/signal interface for the shared recovery function. Do not infer rollback from an HTTP timeout or blindly repost a provider operation.

The accepted approval integration is present in the coordinator's new `src/db/approval-persistence.ts`: it accepts binding plus modal ID, validates the exact recorded review, and resolves exact replay to its original outbox job. A-09 verifies forwarding and response behavior with mocks; database transaction behavior still requires the coordinator's integration checks.

Domain/adapter contract changes are not required for the delivered route corrections. Pilot configuration tests establish structural validation only: `src/config/pilot.ts` still treats timezone, GitHub coordinate strings and identity login as mostly nonempty strings, and does not deduplicate Auth0 issuer/subject pairs. Those are follow-up configuration validation considerations, not demonstrated provider access or safe multi-tenant onboarding.

Next dependency: coordinator review of these owned files, resolution/recording of A09-DB-01 and A09-DB-02, global integration/type/build checks after the shared DB work settles, then separately authorized live acceptance. Update only the existing `tasks.md` ledger.
