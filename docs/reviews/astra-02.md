# A-02 — Slack transport

Owner: A-02. Scope: `src/adapters/slack-api.ts`, `tests/slack-api.test.ts`, this report. Started 2026-09-12. **PASS — owned implementation and focused verification. PARTIAL — coordinator integration and independent review remain.** No provider content or external writes were accessed.

## Changed files and behavior

- `src/adapters/slack-api.ts`: preserves existing write methods and the two-argument error constructor; adds optional bounded transport configuration and `createSlackThreadClient`. Error messages/codes are application constants, provider codes use a fixed allowlist, and no response, request body, token, source, or exception cause is attached to errors. Fetch rejects redirects and disables caching. Response streams are canceled on failure/deadline and capped at 1 MiB.
- `tests/slack-api.test.ts`: 34 focused tests, with table-driven adversarial cases. Covers authorization/scope rejection, HTTP and API rate limits, attempt caps, malformed/oversized bodies, stalled fetch/streams, cancellation during waits, late fetch completion, ambiguous posts, pagination/cursor/root/count failures, channel metadata, and source permalinks. Uses only synthetic fixtures and injected fetch implementations.
- `docs/reviews/astra-02.md`: this handoff, evidence, and remaining integration requirements.

Write/update operations default to a 10,000 ms total deadline; `views.open` is additionally capped at 2,500 ms and never retries. Reads default to 30,000 ms for the entire thread, including channel metadata, every page, every permalink, response bodies, and waits. Optional `timeoutMs` must be between 1 and 30,000; `maxAttempts` is 1–3 (default 3); `maxRetryWaitMs` is 0–10,000 (default 5,000); `signal` cancels requests and waits. These are factory options, so existing method call sites remain valid.

Only reads and `chat.update` retry transient HTTP/API/transport failures. Rate limits need a valid `Retry-After`; if its wait exceeds the wait cap or remaining deadline, the call fails with `slack_rate_limited` instead of shortening Slack's delay. Updates reuse identical serialized channel/timestamp/text bytes and verify the returned channel and timestamp. They have no GitHub dependency or capability. See Slack's [rate-limit guidance](https://docs.slack.dev/apis/web-api/rate-limits/) and [update method](https://docs.slack.dev/reference/methods/chat.update/).

The additive reader verifies `conversations.info` before reading source, rejects shared/DM/archived/nonmember/unknown or mismatched channel metadata, follows every cursor, rejects missing/cyclic/non-progressing pages and conflicting duplicate messages, and requires the root. Root `reply_count`, when present, must agree with the complete result. Caps count bots as well as humans: at most 50 messages and 1 MiB of projected source, with at most one page per allowed message. Arbitrary provider fields are discarded. Eligible human messages receive an actual `chat.getPermalink` result validated for HTTPS, Slack host, exact channel/message path, and optional matching thread/channel query coordinates. It never fabricates source URLs or returns a partial thread after failure.

## Coordinator integration notice

At inspection, the Trigger consumers imported `createSlackRepliesClient` and `fetchCompleteSlackThread` from the separate standalone adapters, outside this worker's ownership. Those paths lack a fetch deadline, safe provider-error allowlisting, a total thread deadline, and an abortable/capped rate-limit wait. No cross-owner files were changed here.

1. Replace those composed read calls in both observer and analysis tasks with `createSlackThreadClient({ botToken, signal? }).fetchThread({ channelId, threadTs, maxMessages: 50, pageSize: 100, botUserId?, botAppId? })`. All arguments are server-derived after tenant/configuration checks. The return retains `CompleteSlackThread` structure. This adapter does not resolve tenant identity or grant access to channels outside the caller's allowlist.
2. Use each returned source message's validated `permalink` instead of the local fabricated `slackPermalink` helper. The existing standalone message type exposes extra fields as `unknown`, so narrow `typeof message.permalink === "string"` before constructing the analysis DTO. A missing permalink must fail closed.
3. Route `slack_post_ambiguous` to durable blocked/uncertain post recovery, never normal task retry. Ensure post claims and destination persistence are tied to the proposal/job with tenant scoping and fencing. Do not let retries of a Slack update re-enter GitHub execution.
4. Verify configured channel metadata/read/permalink permissions with the authorized pilot later. Missing channel flags fail closed; no live scope or success claim is made here.
5. Obtain the coordinator's independent review and run aggregate checks after all shared-checkout workers finish. This worker did not spawn a reviewer.

The user's A-03 coordination update is implemented: `SlackApiClient.openModal` accepts `ApprovalModal | ApprovalNoticeModal`. A denial notice can omit `callback_id`, `private_metadata`, and `submit`; it is sent unchanged and receives only `{ viewId }`. A focused test proves the adapter adds no approval controls or metadata. A-03/the route owner wires optional `openNotice` to this existing method; the transport creates no approval transition.

## Ambiguous proposal posts

The current analysis task calls `chat.postMessage` and then persists the returned message timestamp. A transport timeout, lost response, malformed success, or crash before timestamp persistence can leave a message posted with no durable destination. Replaying the task can then post a second proposal card. Slack's [chat.postMessage documentation](https://docs.slack.dev/reference/methods/chat.postMessage/) explicitly allows partial success before `internal_error` or `fatal_error`; the reviewed method documentation supplies no exactly-once guarantee or documented deduplication retention window for `client_msg_id`. A client-generated ID alone must not be treated as proof of exactly-once delivery.

The transport sends a proposal post at most once per invocation and exposes `slack_post_ambiguous` for transport failures, timeout/abort after dispatch begins, 5xx/transient partial-success errors, unrecognized API failures, or malformed/mismatched success. Definite authentication and rate-limit errors remain classified separately, still without an internal post retry. No `client_msg_id` is generated or represented as an exactly-once guarantee. Returned post channel/message/thread coordinates must match the request before the timestamp is returned.

Coordinator-owned durable post claim/result/recovery handling is needed across task attempts, including the crash-after-success-before-persistence gap. Persist uncertainty and resolve it through bounded read-only reconciliation/manual handling; do not reset an uncertain post to sendable based only on no match. A bounded read failure can also occur before a post and must not be reported as a completed analysis. Result `chat.update` retries target one existing Slack message and must remain entirely separate from GitHub execution.

## Verification

All commands used `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH`; `node --version` returned `v24.20.0`. No environment files were loaded by these checks.

- **FAIL (expected regression baseline):** `node --import tsx/esm --test tests/slack-api.test.ts` reproduced all three initial defects before the transport change: wrong returned channel accepted, arbitrary provider code exposed, untrusted destination sent.
- **PASS:** `node --import tsx/esm --test tests/slack-api.test.ts` — 34 tests passed; 0 failed/canceled/skipped. This is synthetic transport evidence, not a live Slack integration.
- **PASS:** `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --target ES2017 --lib esnext,dom,dom.iterable --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --esModuleInterop --strict src/adapters/slack-api.ts tests/slack-api.test.ts` — exit 0, scoped to owned entry points and their type dependencies.
- **PASS:** `node node_modules/eslint/bin/eslint.js src/adapters/slack-api.ts tests/slack-api.test.ts` — exit 0.
- **PASS:** `git diff --check -- src/adapters/slack-api.ts tests/slack-api.test.ts` — exit 0.
- **PARTIAL:** Production reads require the coordinator wiring above; cross-attempt proposal-post ambiguity requires durable coordinator-owned recovery. Current unit results cannot establish exactly-once posting.
- **NOT RUN:** Full suite, build, provider reads/sends, migrations, deployments, GitHub mutations, and independent review. No branches, package/lock files, shared contracts, database/Trigger files, staging, commits, pushes, or ledger entries were changed by A-02.

The verification-before-completion skill was used to reproduce concrete defects and tie completion claims to fresh focused checks; it introduced no additional approval gate.
