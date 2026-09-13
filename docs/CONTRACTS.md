# Signal implementation contracts

This shared contract implements [PRODUCT.md](PRODUCT.md). The coordinator approves interface changes before dependent work. All IDs below are opaque strings; validate their provider-specific shape at ingress. Use UTC timestamps and database time for expiry.

## Types and immutable material

```ts
type TenantContext = { tenantId: string }; // server-derived, never a browser claim
type TaskInput = { tenantId: string; jobId: string; schemaVersion: 1 };
type Evidence = { messageTs: string; permalink: string };
type Analysis = {
  decisions: { text: string; evidence: Evidence[] }[];
  tasks: { text: string; ownerSlackId: string | null;
    deadlineText: string | null; evidence: Evidence[] }[];
  blockers: { text: string; evidence: Evidence[] }[];
  uncertainties: string[];
};
type Mutation = {
  kind: "CREATE_ISSUE";
  repoId: string; owner: string; repo: string;
  title: string; body: string; assignees: [] | [string];
} | {
  kind: "ADD_PROGRESS_COMMENT";
  repoId: string; owner: string; repo: string;
  issueId: string; issueNumber: number; body: string;
};
type ApprovalBinding = {
  tenantId: string; proposalId: string; operationId: string;
  version: number; payloadHash: string; expiresAt: string;
  slackTeamId: string; channelId: string; actorSlackId: string;
};
```

Allocate an operation UUID before draft creation. Append `<!-- signal-operation:UUID -->` to the final body, rejecting/removing any model-supplied marker first. Normalize line endings once before persistence. Canonical JSON recursively sorts object keys, preserves array order, uses UTF-8 and permits only finite JSON values. SHA-256 covers `{schemaVersion:1,tenantId,operationId,version,mutation}` including marker, destination and assignee. Approval binds this hash and expiry; executor recomputes and compares before any POST. Never normalize or regenerate afterward.

Snapshot hash covers the ordered eligible messages' IDs, authors, edits and text. The action fingerprint covers tenant, channel, thread, snapshot hash, kind and validated destination. Unique fingerprints return the existing pending proposal/result. Lock the thread row while replacing a pending proposal with a new immutable version; mark its predecessor `SUPERSEDED`. While a thread has an approved or unresolved operation, queue no additional write proposal; explain its current state. Full modal rendering is mandatory: title maximum 256 characters and body maximum 6,000 characters, split into supported Slack blocks without truncation; oversized drafts are rejected. Escape presentation markup without changing stored mutation bytes.

## Persistence and states

Use tenant-scoped composite keys/FKs in Drizzle migrations, with database constraints rather than validation alone:

```sql
-- Repeated on every tenant-owned entity:
PRIMARY KEY (tenant_id, id);
-- Representative relationship:
FOREIGN KEY (tenant_id, proposal_id)
  REFERENCES proposals (tenant_id, id);
-- Required distinct uniqueness constraints:
UNIQUE (tenant_id, slack_event_id);       -- inbox
UNIQUE (tenant_id, channel_id, thread_ts);-- threads
UNIQUE (tenant_id, action_fingerprint);  -- proposals
UNIQUE (tenant_id, operation_id);        -- proposals; one draft per operation
UNIQUE (tenant_id, proposal_id);         -- approvals
-- outbox.id IS jobId; its composite primary key is the job deduplication key
```

Tables: `tenants` (unique Slack team, active/config version); `channel_mappings` (channel, repository identity, installation reference); `approvers` (channel, Slack user, enabled); `identity_mappings` (Slack user, GitHub login); `threads` (thread coordinates, linked issue identity, active operation); `inbox` (provider event ID and minimal coordinates for explicit mentions); `observed_events` (verified Slack/GitHub event coordinates, source, event ID, and payload hash only); `snapshots` (content, hash, expiry); `proposals` (thread/snapshot/operation references, version, mutation JSON, hash, expiry, state); `approvals` (binding and approved time); `operations` (state, fencing token, owner attempt, lease, result identity, error code); `outbox` (id=jobId, task ID, typed entity reference including observer events, dispatch/execution states, attempts, leases, Trigger run ID); `audit` (actor/IDs/state/hashes only). There is no separate jobs table. Every listed reference uses a composite tenant FK; use typed nullable entity FK columns with a check allowing exactly the reference required by the task. Channel mapping is unique per tenant/channel; approvers and identity mappings use compound tenant keys. Approval and operation payload fields are write-once. Source/body columns may become null only through retention cleanup.

| Entity | States and permitted progression |
|---|---|
| Proposal | `PENDING → APPROVED / DISMISSED / SUPERSEDED / EXPIRED`; terminal thereafter |
| Operation | `READY → SENDING → SUCCEEDED / FAILED / UNKNOWN`; preflight from `READY` can yield `FAILED / STALE`; only an approved proposal permits sending |
| Reconciliation | `UNKNOWN → SUCCEEDED` or remains `UNKNOWN` with resolution note; no transition back to `SENDING` |
| Outbox execution | `READY → RUNNING → SUCCEEDED / FAILED / BLOCKED`; safe retry may return `RUNNING → READY` after lease fencing |
| Outbox | `PENDING → CLAIMED → DISPATCHED`; stale dispatch claim returns to `PENDING` |

Dismissed/superseded/expired proposals' unused operations become `STALE`. `FAILED` means a definitive failure without creation; `STALE` means authorization or target eligibility changed before sending. After a POST, inconsistent identity is `UNKNOWN`, never `STALE`. A completed analysis can leave a pending proposal. A successful task delivery does not imply a successful mutation. All updates include tenant, expected state and current fencing token; zero affected rows means no authority to proceed.

## Tasks, dispatch and concurrency

| Trigger task ID | Referenced job purpose |
|---|---|
| `signal.analyze-thread` | Load inbox/thread, retrieve, analyze and persist proposal/notification |
| `signal.execute-operation` | Execute one approved immutable operation |
| `signal.reconcile-operation` | Read GitHub to resolve one uncertain operation |
| `signal.notify-slack` | Publish/update proposal or result in its original thread |
| `signal.recover` | Scheduled recovery sweep, one-minute target cadence |
| `signal.cleanup` | Scheduled retention sweep, hourly |
| `signal.search-public-docs` | Optional approved Exa query |

Business task payloads contain only `TaskInput`; load the outbox job by both IDs, verify schema version, task ID and entity ownership, and recheck active tenant configuration. Schedules receive platform schedule metadata only, enumerate tenant IDs, then operate through the same scoped services. Pin SDK/runtime and verify deployment conventions against [Trigger task documentation](https://trigger.dev/docs/tasks/overview).

I-01 may deploy a temporary `signal.preflight` connectivity probe with empty input and constant status output. It handles no workplace content, database jobs or GitHub mutations. It proves task deployment/access only; remove it in I-06 after business-task acceptance exists.

Explicit mentions insert inbox + analysis outbox job atomically. Signed passive Slack/GitHub observer events insert `observed_events` + an ID-only observer outbox job atomically; duplicate provider deliveries return the existing event/job. Approval inserts approval + execution outbox job and transitions the proposal atomically. Mutation success inserts actual result + thread binding + notification outbox job atomically. Use `SELECT … FOR UPDATE SKIP LOCKED` for dispatch claims; commit before external calls. Dispatch with an explicit global idempotency key derived from tenant/task/job. A crash after Trigger acceptance is recoverable by redispatch; database claims still suppress duplicates. Sweep dispatched jobs that never started and terminal failed runs; do not endlessly reset successful task keys.

Executor verifies approved proposal/binding, then claims `READY → SENDING`, assigning attempt/run identity, fencing token and lease transactionally; commit before POST. Disable mutation HTTP retries, SDK retries and redirect following. A duplicate worker seeing `SENDING` exits without POST or reconciliation. The owning worker must remain within a bounded request deadline and lease; after a timeout it aborts its request and records `UNKNOWN`. A crashed owner's recovery requires BOTH expired lease AND confirmed terminal owning Trigger attempt/run, with no continuing retry attempt. If terminality cannot be established, keep blocked. Only then may recovery transition stale `SENDING → UNKNOWN`. Reconciliation also requires the owning attempt to be terminal and its lease exhausted, preventing concurrent reconciliation with an in-flight POST. A database fence cannot cancel a remote request; even terminality does not prove GitHub rejected it.

Reconciliation checks the exact configured repository and issue/comment identity, enumerates pages and matches the application marker. One match with verified target, expected GitHub App author and payload hash settles success; mismatched or multiple matches require manual review while remaining `UNKNOWN`. Incomplete reads or zero matches remain `UNKNOWN` with a resolution note; absence never authorizes reposting. Only read retries are automatic. Definitive non-creation responses may become `FAILED`; ambiguous transport/5xx or malformed success remains `UNKNOWN`. Manual investigation records evidence; it cannot reset an uncertain operation or create an equivalent replacement before ambiguity is resolved. If GitHub creates an issue but drops the requested assignee, persist the actual result and show the mismatch; never PATCH or repeat creation.

## HTTP and authority

Execution lifecycle addendum: outbox execution claims bind tenant/job/task, recorded Trigger run, fencing token and a five-minute execution lease. The business task has a four-minute runtime ceiling and no automatic SDK task retry. Terminal unsuccessful or never-started runs may advance a bounded retry generation only after the execution lease is exhausted and the original run is verified terminal. `SENDING`/`UNKNOWN` GitHub operations never enter that replay path; only reconciliation is queued. Proposal notification state and message timestamp belong to the exact proposal. Result updates use that immutable proposal destination and persist returned assignee evidence.

Approval rows require the persisted modal ID through a composite tenant/proposal/modal foreign key. New proposals capture the locked tenant configuration version. Approval and mutation claim atomically recheck active tenant, exact enabled/non-shared channel mapping, channel-scoped named actor, persisted modal/binding, raw payload hash and database-clock expiry; configuration changes invalidate the proposal. Legacy unknown configuration provenance is version `0`, never silently backfilled authority.

| Route | Behavior and errors |
|---|---|
| `POST /api/slack/events` | Verify raw-body Slack HMAC and timestamp (five-minute tolerance) before parsing; signed URL challenge returns 200. Accepted/duplicate events return 200, ignored events return 202; durable insert failure returns 503; bad signature 401; malformed payload 400 |
| `POST /api/github/webhooks` | Verify raw-body GitHub HMAC before parsing; accepted/duplicate events return 200, ignored events return 202; durable insert failure returns 503; bad signature 401 |
| `POST /api/slack/interactions` | Same signature checks; Review opens persisted modal immediately; Dismiss and modal approval use transactional checks. Valid interaction receives Slack-compatible 200 acknowledgment/validation error; unauthorized actor gets private denial and no transition |
| `GET /healthz` | Public process liveness, 200 with `{status:"ok"}`; no secrets or dependency details |
| `GET /api/internal/maintenance` | Bearer `CRON_SECRET`; 401 unauthorized; run bounded recovery/cleanup dispatch through shared services, 200 with counts or 503 unavailable; no content or credentials in response |
| `GET /api/proposals`, `GET /api/proposals/:id` | Optional authenticated inspector; server maps subject to tenant; paginated summaries/detail; 401 no session, 403 unmapped subject, 404 missing/cross-tenant/disabled |
| `POST /api/copilotkit` | Optional authenticated read-only explanation; selected proposal ID only; same tenant checks, 400 bad input, 429 budget, 503 provider unavailable |
| `/auth/*` | Optional Auth0 SDK-managed login/logout/callback routes; no bespoke GitHub approval endpoint |

Non-Slack errors use `{error:{code,requestId}}`. Do not disclose cross-tenant existence. Authenticated POST routes require same-origin/CSRF protection. Slack interaction metadata is a lookup hint, never authority: persist modal ID, actor and proposal version on Review, then match them on submit. Within a row-locked approval transaction recheck team, channel, named approver, pending version/hash, expiry and active configuration. Repeat submission returns the recorded result. Fetch external target eligibility before dispatch, then revalidate configuration version inside the claim transaction. An inaccessible, closed, transferred, renamed or PR target requires a new review. A change occurring after preflight remains an external race; reject redirects and verify returned IDs, recording uncertainty when identity is inconsistent.

Slack expects acknowledgment and modal trigger use within three seconds; keep this path independent of analysis/tasks. See [Slack interaction handling](https://docs.slack.dev/interactivity/handling-user-interaction/). GitHub adapter exposes only issue-create and issue-comment POST methods plus bounded reads; see [issues](https://docs.github.com/en/rest/issues/issues) and [comments](https://docs.github.com/en/rest/issues/comments).

Optional Exa uses a separate persisted `search_requests` row: tenant, initiating actor, exact sanitized public query, approved domains, hash, expiry and consent state. Show that complete query in Slack; only the initiating actor can approve its unchanged hash within 30 minutes. Atomically record consent and `signal.search-public-docs` outbox job. The job rechecks consent/tenant/expiry and transmits that query only, returning at most three public references. No source thread text, credentials, internal URLs or private identifiers enter the query. This consent grants no GitHub authority and a GitHub approval grants no search consent.
