# A-06 dashboard correctness

Owner: A-06 / Goodall. Completion evidence recorded 2026-09-13 15:24 UTC. Branch: `codex/signal-track-rob`, shared checkout. Scoped implementation and synthetic verification are complete; integration acceptance remains **PARTIAL** for the dependencies below. This is a delivery report, not a second execution ledger.

## Changed files and behavior

- `src/lib/monitoring-data.ts`: require the server-configured active pilot and enabled, non-shared channel/repository mappings before reading monitoring records; reject mixed-tenant results; exclude removed channels and replaced repositories; sort records by their recorded creation timestamps. Database construction/query errors return sanitized unavailable data without fixtures. Pool cleanup cannot expose an underlying exception. A successful read includes a snapshot timestamp and does not claim feed health. The default entry point still takes no arguments; optional dependencies allow isolated tests without reading a real database.
- `src/lib/monitoring.ts`: distinguish pending review, approved/awaiting result, in-progress, failed, uncertain, stale, expired, dismissed and superseded states. Uncertain operations remain visible even alongside a terminal proposal state. Blocked/failed observer work needs attention. Pending classification without worker metadata explicitly states that execution status is unavailable. Consume optional expiry/worker-state fields additively. Use creation timestamps honestly, remove invented participants and avoid serializing tenant identifiers or mutation bodies. Evidence links require valid provider coordinates.
- `src/lib/dashboard-settings.ts`: credential presence is configuration evidence only. Report missing names, including GitHub webhook verification and expected App login; describe setup and live-verification requirements. Explain that optional Auth0 login is disabled. Remove the out-of-roadmap Upstash card; existing exported environment/type names remain compatible. The legacy `ready` enum value is retained for callers, but means names present and is rendered as `Configured · unverified`.
- `src/components/monitoring-dashboard.tsx`: show a persisted snapshot with an explicit Refresh action; unavailable metrics show unknown rather than zero. Count represented source types rather than pretending each record is another connected source. Show exact record states and timestamp limitations. Remove the invented signed-in Rob/profile and hardcoded model claims, fake sparkline, and unavailable workplace-message action. Help, pilot setup and settings buttons navigate to setup guidance. Opening a decision clears conflicting source/search/status filters. Browser history and hashes restore sections. Setup disclosures explain the operator steps and cannot save configuration or connect accounts.
- `src/app/globals.css`: small styles for refresh/setup guidance, neutral unverified configuration indicators and the existing sidebar buttons' missing transparent background. No layout redesign.
- `tests/unit/monitoring.test.ts`, `tests/unit/dashboard-settings.test.ts`: focused behavioral, failure, boundary and actual component-rendering coverage using synthetic records only.
- `docs/reviews/astra-06.md`: this report.

`src/app/page.tsx` was inspected and left unchanged: its existing `force-dynamic` server page loads the server-derived snapshot. No package, lockfile, shared contract, database, Trigger, ledger, branch or unrelated worker file was edited by A-06.

Installed Next.js 16.3.5 documentation was read before code: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md`, `use-router.md` in that directory, and the server/client boundary guide. Refresh uses the documented App Router behavior; the page remains dynamic.

## Verification

All Node commands used `PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH` and existing dependencies, without loading environment files.

| Status | Check | Evidence |
|---|---|---|
| PASS | `node --import tsx/esm --test tests/unit/monitoring.test.ts tests/unit/dashboard-settings.test.ts` | 38/38 tests, zero failed/skipped. Includes missing/inactive/unmapped pilot rejection; trimmed server tenant; mixed-tenant failure; removed mapping exclusion; sanitized connection/query/cleanup failure; every existing proposal/operation state; pending/blocked/failed observer states; optional expiry handling; secret-value exclusion; valid evidence URLs; real React server-rendered unavailable and failed views. |
| PASS | `node node_modules/eslint/bin/eslint.js src/lib/monitoring.ts src/lib/monitoring-data.ts src/lib/dashboard-settings.ts src/components/monitoring-dashboard.tsx tests/unit/monitoring.test.ts tests/unit/dashboard-settings.test.ts` | Exit 0 after fixing one JSX text escape. |
| PASS | `git diff --check -- src/lib/monitoring.ts src/lib/monitoring-data.ts src/lib/dashboard-settings.ts src/components/monitoring-dashboard.tsx src/app/page.tsx src/app/globals.css tests/unit/monitoring.test.ts tests/unit/dashboard-settings.test.ts docs/reviews/astra-06.md` | No whitespace errors. |
| PARTIAL | Scoped TypeScript check, command below | No owned-file diagnostics after correcting test fixtures for Next 16.3.5's `bfcacheId` and a synthetic Pool stub. The command still exits 2 on coordinator-owned `src/db/repositories.ts:241`: the approval insert lacks the newly required `modalId` during shared integration. A-06 did not repair another owner's code. |
| PASS | Synthetic browser interactions | Actual dashboard component and stylesheet rendered in the in-app browser using an in-memory, loopback-only React fixture with a stub Next router. Verified search/source empty state; decision opening clears old filters and selects the requested Slack record; Back restores Decisions; reload restores the hash-selected Activity section; Help/Open settings reach Settings; requirements expand; Sources says feed health is unverified; Activity labels record creation; Refresh invokes its router action. Screenshot inspection confirmed the final sidebar background correction after rebuilding only the in-memory fixture and reloading it. |
| NOT RUN | Real Next/Neon/browser/provider acceptance | The synthetic router counts calls; it does not prove a real `router.refresh()` round trip. No live database queries, provider content, account changes, workplace messages, GitHub writes, migrations, production build, full test suite or deployment were performed. Coordinator owns these acceptance checks. |
| NOT RUN | Fresh independent review of the tenant/read boundary | Required coordinator review before acceptance; this worker was prohibited from spawning agents. |

Scoped type command:

```sh
PATH=/Users/robcr/.nvm/versions/node/v24.20.0/bin:$PATH node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict --target ES2017 --lib ESNext,DOM --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --allowImportingTsExtensions src/lib/monitoring.ts src/lib/monitoring-data.ts src/lib/dashboard-settings.ts src/components/monitoring-dashboard.tsx src/app/page.tsx tests/unit/monitoring.test.ts tests/unit/dashboard-settings.test.ts
```

The temporary browser fixture used only synthetic data, an explicitly labeled synthetic notice and an in-memory esbuild bundle; no fixture files were added to the checkout. Its tab was closed and its exact loopback server process stopped after verification. No real provider links were opened.

## Coordinator integration requests

- **A06-I01 — expiry projection:** The current `PersistedConversationRow` / `listMonitoringConversations` projection omits proposal expiry. Add optional `proposalExpiresAt: Date | null` to the shared row and select `proposals.expiresAt`. A-06 already accepts it and shows elapsed pending proposals as expired. Until supplied, the UI describes the recorded pending state and defers current expiry/authorization checks to Slack. Do not derive expiry from `operationCreatedAt`.
- **A06-I02 — observer execution projection:** A `PENDING` observer may have a failed or blocked worker. Add optional `executionState: string | null` to `PersistedObserverRow` and select the matching tenant/event observer outbox job state. A-06 already distinguishes `READY`, `RUNNING`, `FAILED`, `BLOCKED` and missing-result `SUCCEEDED` when supplied. Without it, pending classification explicitly has unknown worker status. Preserve successful classification results if later delivery fails. Thread analysis/execution progress beyond the existing operation state also remains unavailable in the shared projection and is labeled accordingly.
- **A06-I03 — shared query enforcement:** `listObservedConversations` currently does not itself require an active tenant or enabled mapping. A-06 gates this dashboard loader and filters results against enabled, non-shared pilot mappings. Coordinator should enforce the same boundary at the shared query for other consumers and review the gate for concurrent configuration changes.
- Resolve the shared approval `modalId` type error above, rerun the scoped check/full integration gates, and independently review this loader. Then perform actual pilot refresh, unavailable-state and signed delivery/classification acceptance in the real Next app.

These additive requests were recorded in this report before any cross-owner changes; A-06 made none. There is no claim of live connectivity, authenticated dashboard access, whole-roadmap completion or production acceptance from these tests.
