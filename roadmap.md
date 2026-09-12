# Signal roadmap

Read [north_star.md](north_star.md) first. Status and ownership live only in [tasks.md](tasks.md).

## Delivery clock

The build budget starts when implementation task I-01 is claimed. Documentation preparation is recorded separately and must not consume the protected finishing window. The target assumes the core accounts and app installations can be made available during preflight. Record actual elapsed time in `tasks.md`; never reset the clock after a failure or compaction.

| Elapsed implementation time | Deliverable | Gate |
|---|---|---|
| 00:00–00:30 | Runtime/dependency setup and provider-access preflight | Slack full-thread read, GitHub permissions/reads, database connection, harmless Trigger probe, and OpenRouter structured response verified or precisely blocked; application acceptance follows its implementation tasks |
| 00:30–02:00 | Tenant-aware database, Slack ingestion, analysis, cards, immutable approval, issue/comment actions | Both normal paths work with focused unit/integration checks |
| 02:00–02:45 | Deduplication, outbox recovery, uncertain-write reconciliation, notification recovery | Essential failure tests pass; no blind mutation retry |
| 02:45–03:30 | Optional Auth0-protected CopilotKit inspector | Real login, tenant-filtered proposal explanation; no web approval authority |
| 03:30–04:00 | Optional Exa search and cleanup; other partners only from saved time | Approved sanitized search works or feature remains disabled |
| 04:00–05:00 | Feature freeze, failure/security checks, deployed end-to-end verification | Release acceptance matrix completed with evidence |
| 05:00–06:00 | Visual polish, accessibility, demo rehearsal, runbook and submission evidence | Two-minute demo and handoff ready |

Tests run during coding. The final two hours deepen verification and presentation rather than postponing all testing until the end.

## Parallel tracks

The track split changes ownership and handoff mechanics only. The north star, product scope, delivery clock, dependencies, contracts, gates, and cut rules remain unchanged.

### Track Rob

Rob is the coordinator and integration owner. This track owns the dependency foundations, model/retrieval behavior, recovery, release verification, and final documentation:

- I-01 — runtime and provider-access preflight (currently in progress)
- I-02 — tenant-aware persistence and application contracts
- I-04 — grounded analysis and immutable proposals
- I-06 — reconciliation and result delivery
- O-03 and O-05, only after the core gate and within their existing timeboxes
- V-01 and the final integration/documentation lead for V-02

Rob also owns `tasks.md`, shared contracts, package manifests/lockfiles, dependency changes, and final integration.

### Track Cesar

Cesar works in a separate checkout and OpenAI account as the downstream Slack/GitHub interaction and inspector owner. This track begins each item only when its roadmap dependency is available:

- I-03 — signed Slack ingestion and durable dispatch, after I-02 interfaces are frozen
- I-05 — human approval and deterministic GitHub actions, after I-03 and I-04 interfaces are frozen
- O-01 and O-02, only after the core gate and with Rob reviewing tenant/auth boundaries
- O-04, only after the core gate and within its existing timebox
- V-02 presentation and demo support, using files assigned by Rob during final integration

Cesar may prepare tests or implementation work against the frozen interfaces, but must stop and hand off when a shared contract, dependency, package, or another track's file would need to change.

### Keeping both tracks in sync

- The integrated branch and `tasks.md` are the source of truth. Rob serializes ledger updates; Cesar sends task status, verification evidence, blockers, and the handoff commit before integration.
- Use separate `codex/` branches, named `codex/signal-track-rob` and `codex/signal-track-cesar`. Start each work session by syncing from the latest integrated branch and rereading the current ready/claimed rows.
- Each task has one owner and one bounded file set. Do not edit `north_star.md`, `roadmap.md`, `tasks.md`, `docs/PRODUCT.md`, `docs/CONTRACTS.md`, package/lock files, or shared types from Cesar's branch without an explicit coordinator ruling.
- Rob reviews the handoff diff and focused checks, integrates only the owned files, then updates `tasks.md` with the result and the next dependency-unblocked task. Cesar starts the next item from that integrated state.
- If a dependency or contract changes, pause the affected track, record the ruling and consequence in `tasks.md`, and resume only from the updated integrated state.

## Cut rules

- If preflight exceeds 30 minutes, report the external blocker once and use local contract work where useful. Never represent local fixtures as live integrations.
- If the core normal paths are not working at hour 2, suspend all partner UI/search work and assign every available critical worker to the core dependency chain.
- Authorization, tenant checks, uncertain-write handling, and required tests cannot be cut to preserve a partner integration count.
- At hour 4 freeze new features. If a release gate fails, mark the build incomplete and fix it; do not relabel it code complete to meet a time estimate.
- Optional partner attempts have a 15-minute setup limit each, two repair attempts maximum, and no access to the protected two-hour finishing window. Extra implementation time must fit its roadmap slot or saved coding time.
- The optional sequence is Auth0 + CopilotKit, then Exa, then Ambiguous AI, then Mozilla.ai. Disabled optional features cannot break boot, build, core tasks, or tests.

## Milestones

### M0 — Autonomous implementation package

Save the canonical north star, roadmap, tasks, product requirements, architecture, contracts, infrastructure, partner matrix, tests, operations, demo, and implementation task instructions. Cross-document checks and the initial Astra review are complete. Preserve the original brief and earlier plan as historical references. The stopping-point handoff is [HANDOFF.md](docs/HANDOFF.md); future model policy lives in AGENTS.

### M1 — Code-complete MVP

One workspace, one or more mapped channels, selected GitHub repositories, bounded analysis, exact Slack review, issue creation, progress comments, and durable recovery. Critical tests accompany each slice. No enterprise onboarding or general agent platform.

### M2 — Demo-ready MVP

Deploy to the intended demo environment, prove create/comment/replay behavior, finish the acceptance matrix, rehearse the demo, and record actual partner usage. These tasks occupy the protected final two hours.

### M3 — Multi-tenant SaaS

After M2, add self-service installation/linking, encrypted tenant credentials, installation lifecycle handling, per-tenant quotas, administration, and database row-level security. Admit a second customer only after isolation and credential-revocation tests pass. See [docs/SAAS.md](docs/SAAS.md). This milestone is outside the six-hour target.
