# A-04 grounded proposal progression and cards

Owner: A-04 / McClintock. Completed bounded implementation and focused verification at 2026-09-13 15:19 UTC; ready for coordinator integration/review. Only the six assigned files listed below were edited. Verification uses synthetic fixtures under Node 24. No real provider content, external mutations, migrations, commits, pushes, deployments, package changes, or additional agents.

## Early additive integration requests to Rob

1. Supply `AnalysisContext.version` as `nextVersion` and `linkedIssue` from tenant-scoped persisted state. Both the existing `{ id, number }` shape and Rob's additive `{ issueId, issueNumber }` shape are accepted. Serialize persistence against the thread row, recheck the version, supersede pending predecessors, and block new proposals while an approved/unresolved operation remains active. A-04 does not change the repository or Trigger runner.
2. A-04 adds optional `AnalysisDependencies.findExistingProposal({ tenantId, threadId, actionFingerprint })`, returning `StoredAnalyzedProposal | null`. Required stored fields: `tenantId`, `threadId`, `proposalId`, `version`, `operationId`, `payloadHash`, `snapshotHash`, `actionFingerprint`, `mutation`, and `analysis`. Optional: `metadata`, `candidates`, `analysisDurationMs`. Lookup runs before inference. Return persisted immutable material, including terminal proposals, without refreshing expiry or allocating a new operation. Never report a retained fingerprint as absent because its content was cleaned up; unavailable retained material must withhold regeneration.
3. A-04 adds optional `PersistedProposal.existing: StoredAnalyzedProposal` for a race won by another analysis. If persistence returns a different operation/hash, analysis must load the winner through `existing` or `findExistingProposal`; it must never pair the old proposal ID with newly drafted bytes. Existing three-field persistence responses remain supported when they match the newly persisted operation/hash.
4. The service already passes `ProposalPersistenceInput.analysis` and optional `metadata`, `candidates`, and `analysisDurationMs` through `persistProposal`; the Trigger adapter must forward analysis to Rob's new persistence parameter. Persist analysis and atomically enqueue the proposal notification. Metadata/candidate/timing storage can remain absent: replay labels missing model/prompt metadata `unknown`, and the card labels absent analysis duration `unavailable`. The service never sends Slack messages.
5. Optional `AnalysisContext.previousSourceMessages` is the last successful proposal's retained snapshot. It lets progress extraction focus on added/edited messages while retaining the full current snapshot for fingerprinting. Omit when unavailable; no synthetic prior state is inferred.

## Required persisted result / notification contract

The existing three-field persistence response is unchanged for a successful new insert. For a duplicate or race, return the same identity plus `existing`:

```ts
{
  proposalId: stored.proposalId,
  operationId: stored.operationId,
  payloadHash: stored.payloadHash,
  existing: {
    tenantId, threadId, proposalId, version, operationId, payloadHash,
    snapshotHash, actionFingerprint, mutation, analysis,
    // metadata, candidates, analysisDurationMs are optional
  },
}
```

`analyzeThread` recomputes the fingerprint and payload binding, checks tenant/thread/repository identities and rejects any normalization of persisted mutation bytes. Its result has additive `version`, `reused`, and `analysisDurationMs`. On replay, those identifiers, mutation bytes and version belong to the persisted winner. A response with different operation/hash and no recoverable stored material fails as `analysis_persistence_failed`. The optional lookup can also reload a winner after an ID-only race.

`renderPersistedProposalCard` is synchronous and pure. The proposal notification loader supplies:

```ts
renderPersistedProposalCard({
  proposalId, version, mutation, analysis, state, expiresAt,
  tenantId, operationId, payloadHash,
  // analysisDurationMs and now are optional
});
```

The three identity/hash fields are optional for compatibility, but supplying all three enables full immutable-payload binding verification and is recommended for the coordinator's notification adapter. `state` is the persisted proposal state, not operation or outbox state. Only unexpired `PENDING` records have Review/Dismiss controls. Missing cleaned-up mutation/analysis, invalid bindings, malformed state/expiry, or content that cannot fit a complete Slack message throws sanitized `ProposalCardError`. Notification delivery, original-thread destination, message timestamp, and retry/outbox state remain Rob's responsibility.

## Changed files and behavior

- `src/services/analyze.ts`: next-version context is respected; both linked-issue shapes work; target ID/number/repository/open-issue identity is validated before inference; explicit validated targets take precedence; exact fingerprint lookups and race-winner hydration reuse stored bytes. Optional prior snapshots select added/edited progress facts. Combined related candidates stay at five. No model call, new operation or persistence on a lookup hit.
- `src/services/analysis-schemas.ts`: bounds fact counts, fact text, evidence, owner/deadline fields and draft size; JSON schema and runtime validation agree; draft capacity reserves the generated operation marker.
- Grounding in `analyze.ts`: actionable text must quote a phrase in the same cited source statement; owner requires a direct first-person commitment or explicit named assignment, not speaker identity or a GitHub mapping alone. Deadlines must appear in the cited task statement and retain their unresolved original wording. Draft assignees must be validated task owners. Draft body lines are restricted to validated facts, supported field labels and supplied references; invented owner/deadline/claims and spoofed evidence labels fail before persistence. New-issue titles quote a validated fact. Prompt version is now `signal-analysis-prompt-v2`; no repair model calls are added.
- `src/services/proposal-card.ts`: full immutable title/body/comment, operation marker, assignee, uncertainty and sources render without truncation. Plain-text Slack objects neutralize formatting/control syntax; ampersands/angle brackets are escaped for presentation only. Chunks preserve entities, Unicode code points, whitespace and stored content, and respect Slack text/message bounds. The original `renderProposalCard` entry point remains available.
- `tests/analysis.test.ts`: actual sequential create and linked-progress calls, next version, reuse without inference/search/persistence, concurrent winner restoration and fallback lookup, tenant/thread/hash mismatches, explicit target precedence, linked identity drift, old/spoofed evidence, owners/deadlines and schema limits.
- `tests/proposal-card.test.ts`: exact body recovery including marker/whitespace, maximum-length escape expansion and Unicode, hostile Slack text, all sources, persisted version/hash, progress destinations, terminal/expired controls, missing retained material and overflow.
- `docs/reviews/astra-04.md`: this handoff only; `tasks.md` remains the sole execution ledger.

Slack presentation limits and plain-text formatting were checked against the official [text-object reference](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/) and [section-block reference](https://docs.slack.dev/reference/block-kit/blocks/section-block/). No live Slack rendering was claimed.

## Verification evidence

All commands use `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH` and no environment-file loading.

- PASS — `node --import tsx/esm --test tests/analysis.test.ts tests/proposal-card.test.ts`: 37 tests, 37 pass, 0 fail, 0 skipped.
- PASS — `node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --target ES2022 --lib ESNext,DOM --esModuleInterop src/services/analyze.ts src/services/analysis-schemas.ts src/services/proposal-card.ts tests/analysis.test.ts tests/proposal-card.test.ts`: exit 0, no diagnostics. This is a scoped compile check, not the coordinator's full project typecheck.
- PASS — `node node_modules/eslint/bin/eslint.js src/services/analyze.ts src/services/analysis-schemas.ts src/services/proposal-card.ts tests/analysis.test.ts tests/proposal-card.test.ts`: exit 0, no diagnostics.
- PASS — `git diff --check -- src/services/analyze.ts src/services/analysis-schemas.ts src/services/proposal-card.ts tests/analysis.test.ts tests/proposal-card.test.ts docs/reviews/astra-04.md`: exit 0.
- NOT RUN — complete test suite/build, database concurrency/migration tests, actual provider reads/writes, live model structured output, live Slack cards, and independent review. Those are outside worker authorization or coordinator-owned.

## Remaining integration needs and limits

- PARTIAL until Rob wires the optional lookup, persisted duplicate result, next version/linked issue, retained analysis, and proposal outbox renderer in DB/Trigger. At handoff the current Trigger runner still used the old context/direct-send path; A-04 did not edit it.
- Load the last successful snapshot into `previousSourceMessages` to enforce changed-only progress extraction, including edits. If unavailable, analysis uses the full retrieved thread; it does not invent a prior snapshot. Repository locking/approved-or-UNKNOWN gating and recovery state transitions require the coordinator's independent persistence review.
- Validation deliberately accepts extractive facts and fixed draft lines rather than attempting to certify arbitrary paraphrases. Owner commitment recognition is conservative; unsupported/ambiguous ownership phrasing must remain unassigned or be clarified. This may withhold otherwise useful model output and needs the coordinator's synthetic/live acceptance run; no expensive model fallback or extra inference was added.
- The durable renderer is delivered and verified with synthetic stored records; actual notification delivery/retry and approved create/comment/replay integration remain NOT RUN here.

## Coordinator-delegated persistence follow-on

Ownership is explicitly extended for this follow-on to new `src/db/proposal-persistence.ts`, new `tests/integration/proposal-persistence.test.ts`, and append-only updates to this report. Existing service files, repositories, schema, migrations, contracts and Trigger files are not edited. Main removes/reexports the replaced implementations.

Frozen signatures being implemented:

```ts
createProposal(db: SignalDb, input: ProposalInput): Promise<PersistedProposal>
persistAnalyzedProposal(db: SignalDb, input: AnalyzedProposalInput): Promise<PersistedProposal>
findStoredAnalyzedProposal(db: SignalDb, input: {
  tenantId: string; threadId: string; actionFingerprint: string;
}): Promise<StoredAnalyzedProposal | null>
loadInboxContext(db: SignalDb, input: {
  tenantId: string; inboxId: string;
}): Promise<InboxAnalysisContext | null>
loadProposalNotification(db: SignalDb, input: {
  tenantId: string; proposalId: string;
}): Promise<ProposalNotification | null>
beginProposalNotification(db: SignalDb, input: {
  tenantId: string; proposalId: string;
}): Promise<boolean>
recordProposalNotificationSent(db: SignalDb, input: {
  tenantId: string; proposalId: string; messageTs: string;
}): Promise<boolean>
markProposalNotificationUnknown(db: SignalDb, input: {
  tenantId: string; proposalId: string;
}): Promise<boolean>
```

`ProposalInput` preserves the old fields and adds optional `analysis`. `AnalyzedProposalInput` replaces `snapshotId` with `snapshot`, requires `analysis`, and accepts all `ProposalPersistenceInput` fields; optional proposal ID and optional operation ID remain supported. `InboxAnalysisContext` preserves existing coordinates/repository fields and adds `nextVersion`, optional `linkedIssue: {issueId, issueNumber}` and optional `previousSourceMessages`. `ProposalNotification` supplies the exact persisted card input with tenant/operation/hash plus channel/thread coordinates, notification state and nullable `messageTs`.

Early integration finding: existing `tests/integration/persistence.test.ts` generic seed uses a random mapping repository ID but a hardcoded mutation repository ID. The required exact mapping check will reject that seed. Main owns correcting the existing fixture; this worker does not relax the boundary.

Follow-on verification is in progress using only the coordinator-authorized disposable-schema runner and tests prefixed `A04 persistence`.
