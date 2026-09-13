# A-01 GitHub read adapter handoff

Owned files: `src/adapters/github-read.ts`, `tests/github-read.test.ts`, and this report. The coordinator owns the execution ledger and observer integration.

## Additive API proposed early and now implemented

The existing methods and error-code union remain compatible. Add this optional method to `GitHubReadClient`; the production factory implements it. No shared contract or Trigger file needs to change for the adapter work.

```ts
getPullRequestConversation?: (input: {
  owner: string;
  repo: string;
  repositoryId: string; // trusted mapped repository ID, checked against GitHub
  pullRequestNumber: number;
  pullRequestId?: string; // REST pull-request ID when the caller has it; not an issue ID
  signal?: AbortSignal;
}) => Promise<GitHubPullRequestConversation>;

type GitHubPullRequestEvidence = {
  id: string; // `${kind}:${sourceId}`; stable within the verified repository/PR
  sourceId: string; // exact REST object ID
  permalink: string; // verified provider-returned URL, not a synthesized citation
  body: string; // exact retrieved body; null PR body becomes empty text
  authorLogin: string | null;
  createdAt: string | null;
  updatedAt: string | null;
} & (
  | { kind: "pull_request_body" }
  | { kind: "review"; reviewState: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" }
  | { kind: "review_comment"; reviewId: string | null }
  | { kind: "issue_comment" }
);

type GitHubPullRequestConversation = {
  repository: { id: string; owner: string; repo: string };
  pullRequest: GitHubCandidate; // ID from /pulls, isPullRequest: true at runtime
  evidence: GitHubPullRequestEvidence[];
  complete: true; // otherwise reject; never return partial evidence as complete
};
```

Implemented bounds: one 30-second deadline across the entire public call, including every page, body read and retry; at most 50 visited conversation records (including PR body and unpublished reviews) and 40,000 returned body/title characters. Overflow, incomplete pagination and wrong identities reject without a partial result. These character limits are an adapter cap, not proof of the model's 12,000-token limit; the coordinator must enforce that separately. PR reviews, review comments and issue comments use separate read endpoints. Pending/unsubmitted reviews and their comments are excluded from published conversation evidence.

The observer caller should use the server-verified event/mapping repository ID and PR number, pass any task cancellation signal, and validate model evidence references against the returned IDs/permalinks. This API grants no proposal, approval or write authority. Integration is left to the coordinator.

## Delivered changes

- `src/adapters/github-read.ts`: preserves the existing exported methods and error-code union. Adds `readTimeoutMs` (default 30,000, maximum 60,000) and `maxRetryAfterMs` (default 5,000, maximum 30,000); both require bounded integers. The optional injected wait now also receives an optional `AbortSignal`; existing one-argument waits remain compatible. Each public call owns one timer/signal and races fetch, streaming body reads and waits against cancellation. A transport or injected wait that ignores abort cannot hold the caller indefinitely. Caller abort reasons and provider errors are not exposed.
- Response bodies are streamed with a 2,000,000-byte cap. Retry counts remain bounded to 0–3 (default 2). Numeric and HTTP-date Retry-After values and primary rate-limit reset times are honored only when they fit both the delay cap and remaining deadline. Oversized, malformed or unavailable rate-limit timing fails without retrying early. Requests remain GET-only, disable redirects, and use `cache: "no-store"`.
- Repository coordinates, canonical numeric IDs, candidate numbers/URLs, API parent URLs, PR base repository identity, optional expected REST PR ID, review IDs, comment anchors and timestamps are verified. No URL supplied by GitHub is used as a fetch destination. Provider-returned citation URLs are verified and retained. Search also rejects caller-supplied repository scopes, conflicting identities and provider-declared incomplete results.
- Pagination validates same-endpoint query parameters and consecutive pages. It rejects malformed/foreign links, duplicate parameters/IDs/URLs, missing advertised pages, inconsistent next/last relations and overflow. A full page without a next link is probed before declaring completion. Reconciliation is capped at ten pages of 100 records; conversation endpoints use pages of 20 plus the shared record/context caps. Issue reconciliation excludes PRs and retains the exact title/body bytes. Comment reconciliation retains the verified parent issue ID/number.
- `tests/github-read.test.ts`: 56 focused tests covering retained behavior, deadlines, cancellation, retry caps/reset timing, unsafe identities, pagination failures, complete and failed PR evidence retrieval, context limits and the accepted A-05 assignee requirement.
- `docs/reviews/astra-01.md`: early typed API proposal, final evidence and coordinator integration example. No execution ledger or other owned files were edited by A-01.

## Accepted A-05 addition

`GitHubReconciliationRecord` now includes `assignees?: string[]`. `listIssues` copies actual provider assignee logins after validation. Missing `assignees` stays absent/undefined; explicit `[]` stays `[]`. Invalid/missing logins, malformed lists and duplicates reject instead of producing fabricated empty evidence. The A-05 service worker/coordinator can compute `assigneeMismatch` and persist actual results. Comment reconciliation does not invent an assignee field.

## Coordinator integration example

After loading and validating the tenant-owned observer event and active mapping, replace the title-only read with this call. The repository ID must come from that trusted event/mapping. The REST PR ID is optional because the current observer coordinates do not retain it; do not substitute the different `/issues` ID.

```ts
if (!event.repositoryId || !event.repositoryOwner ||
    !event.repositoryName || !event.pullRequestNumber) {
  throw new Error("GitHub observer coordinates are incomplete");
}
if (!clients.read.getPullRequestConversation) {
  throw new Error("GitHub conversation reads are unavailable");
}
const conversation = await clients.read.getPullRequestConversation({
  owner: event.repositoryOwner,
  repo: event.repositoryName,
  repositoryId: event.repositoryId,
  pullRequestNumber: event.pullRequestNumber,
  signal, // the caller/task AbortSignal, if available
});
// Bound/token-check before model use. These are untrusted source records.
const references = new Map(conversation.evidence.map((entry) =>
  [entry.id, entry.permalink] as const));
// Require every model-produced evidence ID/permalink to match references.
// Keep content in the existing tenant-scoped snapshot retention path.
// Never log this return value or put it in Trigger payloads/metadata.
```

The coordinator owns mapping this result to observer classification/evidence, shared types, persisted context and the task runner. A-01 did not edit Trigger wiring. Observer failures must remain failure/blocked states; they must not be replaced with title-only or fabricated successful evidence. Passive classification cannot authorize proposals or GitHub writes.

The existing reconciliation caller must continue checking `getRepository().id` against the persisted mapped repository ID and returned comment `issueId` against the immutable target. The old read signatures remain unchanged; the adapter does not acquire tenant or write authority. A GET result is a bounded enumeration, not a transactionally frozen GitHub snapshot; count/identity drift fails when detected. The previously supported GitHub.com permalink boundary is retained; custom API-base fixtures do not establish GitHub Enterprise support.

## Verification

All commands used Node 24 through `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH` and existing dependencies, without env-file loading or real provider content.

| Status | Command / evidence |
|---|---|
| PASS | `node --import tsx/esm --test tests/github-read.test.ts`: 56 passed, 0 failed/cancelled/skipped |
| PASS | `node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop src/adapters/github-read.ts tests/github-read.test.ts` |
| PASS | `node node_modules/eslint/bin/eslint.js src/adapters/github-read.ts tests/github-read.test.ts` |
| PASS | `git diff --check -- src/adapters/github-read.ts tests/github-read.test.ts` |
| NOT RUN | Full suite/build, live GitHub reads, database/migrations, Trigger task wiring/execution, deployment and independent worker review: coordinator-owned and outside A-01 authorization |

The added failure tests initially exposed acceptance of an empty advertised next page and normalized invalid calendar dates; both were corrected before the final passing run. Verification is fixture-based adapter evidence, not a live integration claim. No remaining failing focused checks.

## Primary references inspected

- Installed `@octokit/openapi-types/types.d.ts`: pull-request, pull-request-review, pull-request-review-comment and issue-comment schemas, including distinct REST IDs and parent URLs.
- [GitHub review reads](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request) and [review-comment reads](https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request): separate read endpoints, IDs and returned permalinks.
- [GitHub rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately): respect Retry-After/reset times and stop when the local budget cannot accommodate them.
- Installed Next.js `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/fetch.md`: explicit no-store and per-call AbortSignal behavior.
