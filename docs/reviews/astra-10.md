# A-10 independent security and recovery review

Owner: A-10, independent fresh-context reviewer. Service review completed 2026-09-13 15:24 UTC. Exclusive write scope: this report. Branch verified as `codex/signal-track-rob`; shared checkout at base `b359d1d9bb36bcf5123ec2913f7e48dd1f4cee89`. No source changes.

Initial coordinator instruction: review completed A-05/A-03 service diffs first, using their reports; defer review of the unfinished shared DB/outbox lifecycle until the coordinator freezes it. Canonical requirements were read from `AGENTS.md`, `north_star.md`, `roadmap.md`, the assigned A-rows of `tasks.md`, `docs/PRODUCT.md`, and `docs/CONTRACTS.md`. The latest follow-up is first below; the original service review remains preserved.

## A-01/A-02/A-04/A-06 follow-up review (2026-09-13 16:07 UTC)

The coordinator accepted B-A10-01/B-A10-02 and assigned correction to A-03/main. Main subsequently reproduced and fixed raw-loader normalization, reporting the focused persisted-payload regression RED then PASS. B-A10-02 is coordinator-verified corrected; independent closure awaits the requested frozen lifecycle review. The findings below remain historical baseline evidence, not a claim that the now-changing repository still has those exact lines. This follow-up reviewed the four completed reports, owned source/test diffs and relevant callers without changing source.

### New concrete blockers

**B-A10-03 — P1, A-04: the grounding check permits reversing a negated decision (confidence 10/10).** [analyze.ts:256](../../src/services/analyze.ts) accepts any word-bounded substring from the source sentence; [analyze.ts:286](../../src/services/analyze.ts) treats the resulting match as support. The only negation check is inside ownership validation, which a decision never invokes. With synthetic source `We decided not to deploy Friday.`, a model decision `deploy Friday` citing that exact message/permalink passes both extraction and draft validation. The real `analyzeThread` persists one CREATE_ISSUE proposal titled `deploy Friday` with body `Decision: deploy Friday` plus its marker. This reverses the source's meaning while appearing evidence-backed, violating PRODUCT MVP-03/absent-facts rules. It does not bypass the separate human approval requirement.

Required regression: the supplied in-memory reproduction must produce zero proposals, or preserve the entire negative statement rather than the positive claim. Keep polarity and conditions attached to their evidence; include negative decisions and conditional statements, not only negated ownership. A literal substring is not sufficient semantic grounding.

**B-A10-04 — P1, A-06/application boundary: configuring a pilot exposes real dashboard material without viewer authorization (confidence 10/10 for application behavior).** The unchanged [page.tsx:7](../../src/app/page.tsx) calls the loader with no requester identity. [monitoring-data.ts:25](../../src/lib/monitoring-data.ts) checks only server tenant/database configuration and active mappings before returning LIVE records. No gate exists in the root layout, Next configuration, or a proxy/middleware file. [monitoring.ts:122](../../src/lib/monitoring.ts) exposes proposal titles; [monitoring.ts:166](../../src/lib/monitoring.ts) exposes persisted classification reasons. Tenant filtering prevents mixed-tenant rows but does not authorize the viewer. The real loader and React renderer, with two synthetic persisted rows and no requester identity, return both restricted fixture strings in HTML.

This is an existing application boundary left unresolved by the slice, not a claim that A-06 introduced the public page. The canonical read-inspector boundary requires authenticated subject-to-tenant admission (CONTRACTS:100; north_star:35), and no explicit public-private-data exception was found. Required correction before enabling private pilot records: fail closed without an authorized viewer, or demonstrate an enforced deployment access barrier covering this page and its data responses. An unavailable public setup shell can remain while optional Auth0 is disabled. Regression must exercise anonymous/unmapped/mismatched viewers and return no record text. Deployed exposure/access protection: **NOT RUN**, not inferred from this local reproduction.

### Separate slice verdicts

| Slice | Spec compliance | Code quality | Exact evidence / limitation |
|---|---|---|---|
| A-01 GitHub read adapter | PASS, scoped | PASS, scoped | GET-only/no redirects and bounded retries at `github-read.ts:395-438`; scoped pagination and verified PR evidence; 56/56 tests. No new concrete blocker. Production caller wiring and provider completeness remain unverified. |
| A-02 Slack adapter | PASS, scoped | PASS, scoped | `slack-api.ts:217-255` uses one attempt for modal/proposal creation, preserves update bytes and reports ambiguous posts; `326-394` validates complete thread/permalink evidence. 34/34 tests. Durable proposal-post recovery remains coordinator integration scope. |
| A-04 analysis/proposal presentation | FAIL, B-A10-03 | FAIL for grounding validation; other inspected replay/render guards passed | 37/37 existing tests pass but the new synthetic negative-decision probe persists the inverted claim. No approved-byte normalization or UNKNOWN repost was found in this slice; database reuse enforcement is still WIP. |
| A-06 dashboard | FAIL at the application read boundary, B-A10-04 | PARTIAL: mapping/status honesty checks pass; private-data access boundary is missing | 38/38 tests plus actual synthetic SSR reproduction. A-06's unchanged public page is part of this integration limitation; an external access barrier has not been verified. |

### Focused verification for this follow-up

All checks used existing dependencies, Node 24, no environment files and no real DB/provider access.

The following four test commands each ran with `set -o pipefail` and the prefix `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH`. TAP output was filtered to counts/failures with `| rg '^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)|^not ok|^  (error|message|stack)'`.

- PASS — `node --import tsx/esm --test --test-reporter=tap tests/github-read.test.ts`: 56/56, exit 0.
- PASS — `node --import tsx/esm --test --test-reporter=tap tests/slack-api.test.ts`: 34/34, exit 0.
- PASS — `node --import tsx/esm --test --test-reporter=tap tests/analysis.test.ts tests/proposal-card.test.ts`: 37/37, exit 0.
- PASS — `node --import tsx/esm --test --test-reporter=tap tests/unit/monitoring.test.ts tests/unit/dashboard-settings.test.ts`: 38/38, exit 0.
- Total: **165 passed; zero failed/skipped/cancelled/todo**.
- PASS reproduction, not acceptance — the two exact inline commands in the follow-up probe appendix both exit 0. Negative-decision output: `negatedDecisionAcceptedAsPositive=true, persistedProposals=1, syntheticModelCalls=2, providerCalls=0`. Dashboard output: `requesterIdentityProvided=false, liveRecordsReturned=2, privateTitleInHtml=true, privateReasonInHtml=true, realDbCalls=0, providerCalls=0`.
- PASS — `node node_modules/eslint/bin/eslint.js src/adapters/github-read.ts src/adapters/slack-api.ts src/services/analyze.ts src/services/analysis-schemas.ts src/services/proposal-card.ts src/lib/monitoring.ts src/lib/monitoring-data.ts src/lib/dashboard-settings.ts src/components/monitoring-dashboard.tsx src/app/page.tsx src/app/layout.tsx next.config.ts tests/github-read.test.ts tests/slack-api.test.ts tests/analysis.test.ts tests/proposal-card.test.ts tests/unit/monitoring.test.ts tests/unit/dashboard-settings.test.ts`: exit 0.
- PASS — `node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --allowImportingTsExtensions src/adapters/github-read.ts src/adapters/slack-api.ts src/services/analyze.ts src/services/analysis-schemas.ts src/services/proposal-card.ts`: exit 0; adapter/analysis scope only.
- PASS — `git diff --check --` the exact same file list as the lint command: exit 0.
- NOT RUN — full tests/build/typecheck, real Next request/browser refresh, deployed anonymous/private access, actual DB/transactions/races, provider/model/Trigger requests, provider pagination against live content, retention and dispatch-crash checks. Shared DB/outbox freeze has not been requested; none of those files were edited or accepted here.

SHA-256 checkpoints for the two new blocker paths: `src/services/analyze.ts` = `0beeaff759807be14ef4d46b7e8d8c32c6355f25954e1b0d320f56f7934f4da2`; `src/lib/monitoring-data.ts` = `319bfd15695a31454a672e4c6dc6b07de37cdaf6c50edeb67539b60dab61b7cd`; `src/lib/monitoring.ts` = `39c96af6e201b220e11e6158d1661bae6653d36f735c353a0f5b4409abbada35`; unchanged `src/app/page.tsx` = `998d645cf97b57bff8ddf7bc75bc014d8d399df913511d05ed904537e8d500b3`.

Only this report changed. The review skill's trust-boundary checklist informed the final cross-check; its source fixes, agent dispatches, provider operations and extra log writes were excluded by the coordinator's scope. No broad style findings.

### Final scoped handoff and report-link correction

- Scope review is complete for A-01/A-02/A-04/A-06. Fresh SHA-256 checks matched all ten previously reviewed source files; no additional critical slice finding was identified. The separate verdicts above stand. B-A10-03 remains the A-04 source blocker; B-A10-04 remains an existing A-06/application access-boundary blocker, not a new public-route regression.
- Corrected only this report's six source-link targets to `../../src/...`, with line numbers retained in link labels. `python3 scripts/check_docs.py` reproduced exactly six broken links before the correction (exit 1), then **PASS** after it (exit 0; 24 required files, 52 Markdown documents). This check verifies documentation structure, not application acceptance.
- Fresh **PASS** — `node --import tsx/esm --test --test-reporter=tap tests/github-read.test.ts tests/slack-api.test.ts tests/analysis.test.ts tests/proposal-card.test.ts tests/unit/monitoring.test.ts tests/unit/dashboard-settings.test.ts`, with the Node 24 prefix, `pipefail` and count filter documented above: 165/165, zero failed/skipped/cancelled/todo, exit 0. Both follow-up inline probes were rerun and still reproduced B-A10-03/B-A10-04 with the same counts and zero DB/provider calls.
- Main reports all tasks now use `runOutboxJob`, and per-proposal destinations, actual assignees and monitoring projections are integrated. These are coordinator-reported WIP changes, **NOT RUN** as an independent frozen lifecycle review. Await the A-03/A-04 persistence modules and coordinator freeze before reviewing that shared boundary.
- The verification-before-completion skill prompted the fresh checker/test/probe runs. No source, other report, ledger, contract, package/lock, DB or Trigger file was edited; no global build/test or provider call was made.

## Original service-review baseline findings (historical)

These were reproduced integration blockers in the repository boundary at the initial service-review snapshot, not newly requested changes to worker-owned services. They refine the existing A03-DB-01 integration request. Main now reports B-A10-02 corrected with RED/PASS regression evidence; the frozen review will independently verify the new boundary. Do not treat the original line references or probe expectations below as current-state assertions.

### B-A10-01 — P1: required modal identity is rejected before approval reaches the transaction

- Evidence: `src/services/approve.ts:289` forwards `{ ...binding, modalId }`; `src/app/api/slack/interactions/route.ts:61` passes it directly to `approveProposal`; `src/db/repositories.ts:234-235` parses that whole object through the strict canonical `ApprovalBindingSchema`, which has no modal field (`src/domain/contracts.ts:83-94`). Contract: `docs/CONTRACTS.md:104` requires persisted modal authority and atomic replay.
- Reproduction: pass a synthetically valid `ApprovalRequest` with `modalId` to the real `approveProposal` function and a DB proxy that throws on any property access. The function rejects with Zod `unrecognized_keys` for `modalId`; the proxy is never accessed. Thus every otherwise valid modal submission currently fails before approval persistence.
- Required correction: validate/extract the accepted modal field separately, retain strict canonical binding validation, then atomically verify and bind the exact persisted modal. Do not fix this by silently stripping modal authority. Exact replay must return the original approval/job only for the original actor/modal/binding.
- Verification: PASS reproduction with zero DB/provider calls. Full atomic approval/replay test against a real DB: NOT RUN.

### B-A10-02 — P1: repository loaders hide mutation corruption from exact-byte validation

- Evidence: `src/db/repositories.ts:163-169` and `src/db/repositories.ts:274-286` return `MutationSchema.parse(row.mutation)` instead of the persisted mutation. The schema trims title and ID-like fields. `src/services/execute.ts:79-81` and `src/services/approve.ts:119-126` correctly hash and compare the object they receive, but cannot recover bytes already changed by a loader. Contract: `docs/CONTRACTS.md:34` forbids normalization after persistence and requires exact recomputed approval hashes.
- Reproduction: begin with a correctly hashed synthetic proposal; change only the stored title by adding leading/trailing spaces and retain its old hash. Feed that row to the real loaders using an in-memory select-chain double. Both loaders return the trimmed title. The raw corrupted proposal is rejected by the real executor; the loader-returned proposal passes and reaches exactly one injected mock POST through the real write adapter. No DB or GitHub request occurs.
- Required correction: validate while preserving the original persisted mutation, or reject a parse whose canonical representation differs from the raw row. Apply the same rule to all loaders and atomic validators consuming approved mutation data. Never use creation-only `payloadHash`/`prepareMutation` to validate already persisted approval material.
- Verification: PASS reproduction: two normalizing loaders, raw corruption rejected, normalized corruption reached mock POST, zero real DB/provider calls. Coordinator persistence regression must prove the raw stored corruption remains visible and no claim/POST occurs.

## Slice verdicts

| Slice | Spec compliance | Code quality | Integration/release status |
|---|---|---|---|
| A-05 — execute/reconcile/notify and focused tests | PASS within the accepted service dependency contracts | PASS scoped source review; no service-local critical blocker found | Initial boundary failed B-A10-02; coordinator reports corrected. Independent frozen lifecycle acceptance remains NOT RUN |
| A-03 — approve/slack-interactions and focused tests | PASS within the accepted atomic repository and notice-hook contracts | PASS scoped source review; no service-local critical blocker found | Initial boundary failed B-A10-01/B-A10-02; approval module is pending and main reports raw loaders corrected. Frozen acceptance remains NOT RUN |
| Coordinator DB/schema/Trigger/recover-outbox lifecycle | NOT RUN as a final frozen-diff review | NOT RUN | Awaiting coordinator freeze; the two narrow boundary reproductions above are not a complete lifecycle audit |

### A-05 evidence

- `execute.ts:70-81` hashes exact persisted canonical material, rejects schema normalization and requires one exact own marker. `execute.ts:125-150` gates POST on a successful claim, propagates a bounded abort signal, verifies numeric provider identity and exact issue/comment URL, and has no retry loop. `github-write-standalone.mts:165-175,280-299` serializes the supplied fields unchanged, forwards the abort signal, and forbids redirects.
- `execute.ts:151-171` separates uncertain/definitive provider outcomes from success-persistence failures. A failed or lost success transaction cannot become proof of non-creation. Assignment evidence is preserved and a dropped assignment reports a mismatch without PATCH or another creation.
- `reconcile.ts:52-108` requires an expired lease, usable owner/fence, confirmed terminal owner, and a successful fenced SENDING-to-UNKNOWN transition before reads. `reconcile.ts:110-155` requires the exact repository, unique marker, body/title, expected App author, numeric ID, and comment parent/URL. Missing/ambiguous/incomplete evidence remains UNKNOWN. The reconciliation dependency surface contains no mutation client or transition back to SENDING.
- `notify.ts:66-87` validates complete matching context when either side supplies it, then whitelists only channel, existing message timestamp and rendered text for Slack. Arbitrary persisted error/resolution text is excluded. Existing compatibility permits both contexts to be absent, so the coordinator must wire both persisted contexts for production enforcement.
- Quality limitation in an existing new test: `tests/execution.test.ts:220-228` describes a matching-hash malformed-marker test but computes the hash with the creation helper, which removes/replaces markers. That test can pass at the hash mismatch branch alone. An additional read-only in-memory probe used exact raw canonical hashes for missing, duplicate and foreign markers: all three were independently rejected before another mock POST. The actual service marker check works; the repository regression should preserve this stronger fixture construction.

### A-03 evidence

- `approve.ts:105-139,181-238` validates exact tenant/proposal identity, immutable material, current named actor, finite expiry, and unchanged displayed review after Slack assigns a modal ID. Mutation material is not regenerated after review.
- `approve.ts:251-293` requires persisted review identity matching modal, actor, tenant, team, channel and version, then exact operation/hash/expiry. It rechecks the named actor and expiry after asynchronous work and passes the original modal into the atomic repository. Allowing APPROVED through the service supports result replay only; the repository remains responsible for comparing against the original approval and never inserting a second job.
- `slack-interactions.ts:193-209` derives the actor from the signed Slack payload and resolves the tenant from the verified team; private metadata cannot replace either. Contradictory hints, normalized metadata, injected fields and repeated form payloads fail closed. The route verifies the raw-body signature before calling this parser.
- `slack-interactions.ts:142-156,176-183` provides a private non-approval notice on denial and never reuses a consumed trigger after failed review recording. The inspected route supplies `openModal` but no `openNotice` (`src/app/api/slack/interactions/route.ts:24-67`); this remains the already documented A-03/A-09 wiring dependency. Without it, unauthorized button actions do not display the required private notice.
- Correct modal authority at the service boundary does not prove atomic authority. The current WIP `approveProposal` update (`repositories.ts:239`) and `claimMutation` update (`repositories.ts:248`) still need the previously requested row-locked actor/team/channel/expiry/active-config/target/thread bindings and captured preflight configuration-version fence. Reproduce a revocation/remap between service precheck and transaction, and between target preflight and claim; require zero approval/claim/POST. Real DB race tests: NOT RUN.

## Verification performed

All commands use existing dependencies with `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH`. No environment files loaded.

- PASS — `node --import tsx/esm --test --test-reporter=dot tests/execution.test.ts tests/recovery.test.ts tests/approval.test.ts tests/slack-interactions.test.ts` — exit 0, 130 passing test dots. These are dependency-injected unit checks, not real DB or provider tests.
- PASS — `git diff --check -- src/services/execute.ts src/services/reconcile.ts src/services/notify.ts src/services/approve.ts src/services/slack-interactions.ts tests/execution.test.ts tests/recovery.test.ts tests/approval.test.ts tests/slack-interactions.test.ts` — exit 0.
- PASS — the exact `node --import tsx/esm --input-type=module -e` command in the probe appendix — real exported repository/service/adapter functions with throwing DB proxy or in-memory select double, disabled global network, injected mock fetch; asserts both blockers and three exact-raw-hash marker rejections. Output contains only booleans/counts: `modalInputRejectedBeforeDb=true`, `normalizedLoaders=2`, `rawCorruptionRejected=true`, `normalizedCorruptionReachedMockPost=true`, `invalidMarkersRejectedWithExactRawHashes=3`, `realDbCalls=0`, `realProviderCalls=0`. No fixture or source files created.
- PASS — `node node_modules/eslint/bin/eslint.js src/services/execute.ts src/services/reconcile.ts src/services/notify.ts src/services/approve.ts src/services/slack-interactions.ts tests/execution.test.ts tests/recovery.test.ts tests/approval.test.ts tests/slack-interactions.test.ts` — exit 0.
- PASS — `node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --allowImportingTsExtensions src/services/execute.ts src/services/reconcile.ts src/services/notify.ts src/services/approve.ts src/services/slack-interactions.ts` — exit 0, service-scope compilation only. The initial invocation omitted `--allowImportingTsExtensions` and returned TS5097 for the existing `.mts` import; correcting that command option resolved it without source changes.
- PASS — `git diff --no-index --check /dev/null docs/reviews/astra-10.md` produced no whitespace diagnostics (exit 1 reflects the new-file difference). Service hashes were unchanged after focused checks, and the branch remained `codex/signal-track-rob`.
- NOT RUN — real database queries/transactions/concurrency, migrations, full suite/typecheck/build, deployed signed Slack interactions, Slack modal timing/private notice display, GitHub/Trigger provider operations, retention sweep or dispatch crash smoke. These require coordinator-owned integration work and are not inferred from unit results.

Service content fingerprints for this review (`shasum -a 256`):

| File | SHA-256 |
|---|---|
| `src/services/execute.ts` | `a73701d2e846971829925c90ab57e7f769fed1f499ad169536f9cca3267a46a0` |
| `src/services/reconcile.ts` | `37931e527d0ae7dcdbfd44188cd6a1b8ae03da4a39ed3bf4ad92ce07f3d424bd` |
| `src/services/notify.ts` | `162487d52b8b85100005619dfc86ce1c155abccfeb6d8a9863003157dc796a00` |
| `src/services/approve.ts` | `6b66a58862bf450d6693f91a0d08a9a66e7bd86d25487e1cd2bf761d13fd9668` |
| `src/services/slack-interactions.ts` | `70e4225c89ef5a3aed0a3810176ddd9e7eb9c43d90e025485d62df11c1ef4a73` |

## Next review dependency

On the coordinator's explicit freeze/request, review the final diff of `src/db/{repositories,schema}.ts`, `src/trigger/**`, `src/services/recover-outbox.ts` and relevant focused lifecycle checks. Required remaining evidence: tenant-scoped FKs/queries; atomic approval/claim/config fences; thread-version reuse and UNKNOWN suppression; dispatch acceptance/process-crash/terminal-attempt recovery; exact-proposal notification destinations; expiry, source/body cleanup and retained deduplication tombstones. Do not interpret this report as a freeze or approval of those WIP files.

No agents spawned, branch changes, staging, commits, pushes, deployments, migrations, DB/provider mutations, workplace messages or edits outside this report. The verification-before-completion skill informed the fresh focused checks and separation of unit evidence from unrun external checks. Available for the frozen shared lifecycle review on coordinator request.

## Reproducible in-memory probe

This is the exact inline probe executed above. All material is synthetic; global network access is disabled inside the process, repository reads use an in-memory double, and the sole POST uses an injected fetch double.

```sh
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx/esm --input-type=module -e '
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "./src/domain/contracts.ts";
import { approveProposal, loadApprovedProposalForExecution, loadProposalForApproval } from "./src/db/repositories.ts";
import { executeApprovedProposal } from "./src/services/execute.ts";
import { createGitHubWriteClient } from "./src/adapters/github-write-standalone.mts";
globalThis.fetch = async () => { throw new Error("network_disabled"); };
const mutation = { kind: "CREATE_ISSUE", repoId: "1", owner: "acme", repo: "signal", title: "Review fixture", body: "Synthetic\n<!-- signal-operation:op-review -->", assignees: [] };
const hashOf = (value) => createHash("sha256").update(canonicalJson({ schemaVersion: 1, tenantId: "tenant-review", operationId: "op-review", version: 1, mutation: value }), "utf8").digest("hex");
const binding = { tenantId: "tenant-review", proposalId: "proposal-review", operationId: "op-review", version: 1, payloadHash: hashOf(mutation), expiresAt: "2030-01-01T01:00:00.000Z", slackTeamId: "T1", channelId: "C1", actorSlackId: "U1", modalId: "V1" };
let dbAccesses = 0;
const forbiddenDb = new Proxy({}, { get() { dbAccesses++; throw new Error("db_disabled"); } });
await assert.rejects(approveProposal(forbiddenDb, binding), (error) => error.issues?.some((issue) => issue.code === "unrecognized_keys" && issue.keys?.includes("modalId")));
assert.equal(dbAccesses, 0);
const original = { ...binding, state: "APPROVED", expiresAt: new Date(binding.expiresAt), mutation };
const corrupt = { ...original, mutation: { ...mutation, title: " Review fixture " } };
const chain = { from() { return this; }, innerJoin() { return this; }, where() { return this; }, async limit() { return [structuredClone(corrupt)]; } };
const fakeDb = { select() { return chain; } };
const loaded = await loadApprovedProposalForExecution(fakeDb, { tenantId: binding.tenantId, operationId: binding.operationId });
const forReview = await loadProposalForApproval(fakeDb, { tenantId: binding.tenantId, proposalId: binding.proposalId });
assert.equal(loaded.mutation.title, mutation.title);
assert.equal(forReview.mutation.title, mutation.title);
assert.notEqual(hashOf(corrupt.mutation), corrupt.payloadHash);
let mockPosts = 0;
const github = createGitHubWriteClient({ token: "synthetic", fetchImpl: async (_url, init) => {
  mockPosts++;
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.deepEqual(JSON.parse(init.body), { title: mutation.title, body: mutation.body, assignees: [] });
  return new Response(JSON.stringify({ id: 7, number: 7, html_url: "https://github.com/acme/signal/issues/7", assignees: [] }), { status: 201, headers: { "content-type": "application/json" } });
}});
const deps = { now: () => new Date("2030-01-01T00:00:00.000Z"), loadApprovedProposal: async () => loaded, claimMutation: async () => ({ fencingToken: 1 }), github, recordSuccess: async () => ({ jobId: "synthetic-job" }), recordFailure: async () => {}, recordUnknown: async () => {}, recordStale: async () => {} };
await assert.rejects(executeApprovedProposal({ tenantId: binding.tenantId, operationId: binding.operationId, attemptId: "synthetic-attempt" }, { ...deps, loadApprovedProposal: async () => corrupt }), (error) => error.code === "execution_payload_mismatch");
const result = await executeApprovedProposal({ tenantId: binding.tenantId, operationId: binding.operationId, attemptId: "synthetic-attempt" }, deps);
assert.equal(result.state, "SUCCEEDED");
assert.equal(mockPosts, 1);
let rejectedMarkers = 0;
for (const body of ["Synthetic", mutation.body + "\n<!-- signal-operation:op-review -->", mutation.body + "\n<!-- signal-operation:other -->"]) {
  const changed = { ...mutation, body };
  await assert.rejects(executeApprovedProposal({ tenantId: binding.tenantId, operationId: binding.operationId, attemptId: "synthetic-attempt" }, { ...deps, loadApprovedProposal: async () => ({ ...original, mutation: changed, payloadHash: hashOf(changed) }) }), (error) => error.code === "execution_payload_mismatch");
  rejectedMarkers++;
}
assert.equal(mockPosts, 1);
console.log(JSON.stringify({ modalInputRejectedBeforeDb: true, normalizedLoaders: 2, rawCorruptionRejected: true, normalizedCorruptionReachedMockPost: true, invalidMarkersRejectedWithExactRawHashes: rejectedMarkers, realDbCalls: dbAccesses, realProviderCalls: 0 }));
'
```

## Follow-up reproducible probes

These commands use only synthetic inputs and injected dependencies. They call no live DB or provider. Each prints only assertion counts/booleans; an exit-0 reproduction means the defect was observed, not that the slice passed acceptance.

### B-A10-03: dropped negation reaches persistence

```sh
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx/esm --input-type=module -e '
import assert from "node:assert/strict";
import { analyzeThread } from "./src/services/analyze.ts";
globalThis.fetch = async () => { throw new Error("network_disabled"); };
const source = { ts: "1710000000.000001", user: "U1", text: "We decided not to deploy Friday.", permalink: "https://team.slack.com/archives/C1/p1710000000000001" };
const context = { tenantId: "tenant-review", threadId: "thread-review", channelId: "C1", threadTs: source.ts, version: 1, invocationText: "Summarize this as an issue", repository: { repoId: "1", owner: "acme", repo: "signal" }, sourceMessages: [source], identityMappings: {}, now: new Date("2030-01-01T00:00:00.000Z") };
let persists = 0, modelCalls = 0;
const dependencies = { github: { search: async () => { throw new Error("unexpected_search"); }, getIssue: async () => { throw new Error("unexpected_read"); } }, model: { modelVersion: "synthetic", complete: async ({ schemaName }) => {
  modelCalls++;
  return schemaName === "signal_fact_extraction" ? { analysis: { decisions: [{ text: "deploy Friday", evidence: [{ messageTs: source.ts, permalink: source.permalink }] }], tasks: [], blockers: [], uncertainties: [] }, searchQueries: [] } : { title: "deploy Friday", body: "Decision: deploy Friday", assigneeSlackId: null, relatedCandidateIds: [] };
}}, persistProposal: async (input) => { persists++; return { proposalId: "proposal-review", operationId: input.operationId, payloadHash: input.payloadHash }; } };
const result = await analyzeThread(context, dependencies);
assert.equal(result.mutation.kind, "CREATE_ISSUE");
assert.equal(result.mutation.title, "deploy Friday");
assert.equal(persists, 1);
assert.equal(modelCalls, 2);
console.log(JSON.stringify({ negatedDecisionAcceptedAsPositive: true, persistedProposals: persists, syntheticModelCalls: modelCalls, providerCalls: 0 }));
'
```

### B-A10-04: private synthetic record text renders without a viewer

```sh
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node --import tsx/esm --input-type=module -e '
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { loadMonitoringDashboardData } from "./src/lib/monitoring-data.ts";
import { MonitoringDashboard } from "./src/components/monitoring-dashboard.tsx";
globalThis.fetch = async () => { throw new Error("network_disabled"); };
process.env.SIGNAL_DASHBOARD_TENANT_ID = "tenant-review";
process.env.DATABASE_URL = "synthetic-not-a-connection";
const data = await loadMonitoringDashboardData({
  createDb: () => ({ db: {}, pool: { end: async () => {} } }),
  loadConfiguredPilot: async () => [{ channelId: "C1", repositoryId: "1", repositoryOwner: "acme", repositoryName: "signal" }],
  listMonitoringConversations: async () => [{ tenantId: "tenant-review", threadId: "thread-review", channelId: "C1", threadTs: "1710000000.000001", threadCreatedAt: new Date("2030-01-01T00:00:00.000Z"), operationCreatedAt: null, repositoryOwner: "acme", repositoryName: "signal", proposalId: "proposal-review", proposalVersion: 1, proposalState: "PENDING", proposalMutation: { kind: "CREATE_ISSUE", title: "SYNTHETIC_RESTRICTED_TITLE" }, operationState: "READY" }],
  listObservedConversations: async () => [{ tenantId: "tenant-review", eventId: "event-review", source: "github", eventType: "pull_request.opened", channelId: null, threadTs: null, messageTs: null, repositoryId: "1", repositoryOwner: "acme", repositoryName: "signal", pullRequestNumber: 7, classificationState: "SIGNAL", classificationReason: "SYNTHETIC_RESTRICTED_REASON", createdAt: new Date("2030-01-01T00:01:00.000Z") }]
});
assert.equal(data.mode, "LIVE");
const router = { bfcacheId: "synthetic", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, createElement(MonitoringDashboard, { data })));
assert.ok(html.includes("SYNTHETIC_RESTRICTED_TITLE"));
assert.ok(html.includes("SYNTHETIC_RESTRICTED_REASON"));
assert.equal(data.conversations.length, 2);
console.log(JSON.stringify({ requesterIdentityProvided: false, liveRecordsReturned: data.conversations.length, privateTitleInHtml: true, privateReasonInHtml: true, realDbCalls: 0, providerCalls: 0 }));
'
```
