# Signal tasks

This is the sole execution ledger. Read [north_star.md](north_star.md), [roadmap.md](roadmap.md), and [AGENTS.md](AGENTS.md) before selecting work.

## Current step

**STOPPED FOR TODAY — 2026-09-11, at the completed documentation milestone.** No implementation task is claimed. I-01 remains READY for the next user-directed session; use [HANDOFF.md](docs/HANDOFF.md). Do not resume overnight or dispatch Astra automatically.

**Scoped user-directed onboarding — 2026-09-12:** C-01 setup is verified; full onboarding is PARTIAL and BLOCKED on B-CPK-02 (unimplemented application/authentication/proposal prerequisites). B-CPK-01 is resolved. I-01 is now IN_PROGRESS for the user-requested Trigger.dev bootstrap; remaining provider preflight is pending.

Documentation work started: 2026-09-12 00:21 UTC (2026-09-11 in America/Mexico_City).
Implementation clock: **NOT STARTED**. The four-hour coding target begins when I-01 is claimed; two additional hours are reserved for finishing.

## Task board

| ID | Task | Depends on | Owner/model | Status | Evidence / next action |
|---|---|---|---|---|---|
| D-01 | Canonical north star, roadmap, agent rules, source preservation, task briefs | — | Coordinator | DONE | Root guides, task plan, configuration examples and checker verified; M0 accepted |
| D-02 | Architecture, typed contracts, infrastructure, SaaS boundaries | D-01 contracts briefing | Astra / write_architecture | DONE | [Delivery report](docs/reviews/D-02.md); accepted by D-05 after contract alignment |
| D-03 | Verification matrix, operations, two-minute demo | D-01 contracts briefing | Luna / write_verification | DONE | [Delivery report](docs/reviews/D-03.md); recovery rules and real-identity demo reviewed |
| D-04 | Partner integration matrix and current source evidence | D-01 contracts briefing | Luna / write_integrations | DONE | [Delivery report](docs/reviews/D-04.md); all eight roles and evidence gates reviewed |
| D-05 | Cross-document validation and independent Astra review | D-01, D-02, D-03, D-04 | Astra reviewer + coordinator | DONE | [Astra review: PASS](docs/reviews/D-05.md); required correction and scoped rereview complete |
| D-06 | Final stopping-point handoff and affordable-model policy | D-05 | Coordinator + Luna audit | DONE | [Handoff review](docs/reviews/D-06.md); small I-01 steps and current model policy verified |
| C-01 | Run requested CopilotKit onboarding and follow applicable setup instructions | Explicit user request | Coordinator + Luna verification | BLOCKED | PARTIAL: CLI 4.9.60, login, managed project and both keys verified; B-CPK-02: Next.js/Auth0/tenant-proposal prerequisites must exist before actual read-only inspector integration |
| I-01 | Bootstrap compatible runtime and verify real core integration access | D-05 | Coordinator | IN_PROGRESS | Claimed 2026-09-12 01:15 UTC for Trigger.dev bootstrap; Node 24/npm verified, Trigger project initialized and local worker ready; remaining Slack/GitHub/database/OpenRouter preflight pending |
| I-02 | PostgreSQL contracts, tenant scope, inbox/outbox and operations | I-01 runtime | Worker + reviewer | TODO | Focused DB transaction and isolation tests |
| I-03 | Slack verification, mention intake, complete thread adapter and dispatch | I-02 | Worker + reviewer | TODO | Signed callbacks, deduplication, acknowledged durable acceptance |
| I-04 | OpenRouter/OpenAI extraction, GitHub retrieval and immutable proposals | I-02, I-03 contracts | Worker + reviewer | TODO | Grounded schema-valid result with hard context limits |
| I-05 | Slack review modal, named-actor approval, create/comment executor | I-03, I-04 | Worker + reviewer | TODO | Two real normal paths and authorization tests |
| I-06 | Unknown-write reconciliation, recovery dispatcher and Slack result updates | I-05 | Worker + reviewer | TODO | Replay/crash/notification failure tests |
| O-01 | Auth0-protected read-only proposal inspector | I-04, I-06 core gate | Auth worker + UI worker + reviewer | OPTIONAL | Defer if core slips; setup cap 15 minutes |
| O-02 | CopilotKit read-only proposal explanation | O-01 | UI worker + reviewer | OPTIONAL | Server loads authorized context; no write tools |
| O-03 | Approved sanitized Exa public documentation query | I-06 core gate | Adapter worker + reviewer | OPTIONAL | Exact query approval; timeout does not block core |
| O-04 | Ambiguous AI read-only allowlisted demo runbook retrieval | I-06; saved coding time | Supporting worker + reviewer | OPTIONAL | Real API/schema required; no outbound workplace writes |
| O-05 | Mozilla.ai offline evaluation on synthetic fixtures | I-06; saved coding time | Supporting worker + reviewer | OPTIONAL | Actual evaluation result; no production dependency |
| V-01 | Required failure/security/tenant checks and deployed end-to-end verification | I-06 | Worker + reviewer | TODO | Protected finishing hour 1 |
| V-02 | UI polish, demo rehearsal, documentation and integration evidence | V-01 | Presentation worker + reviewer | TODO | Protected finishing hour 2 |
| S-01 | Multi-tenant SaaS expansion | V-02 | Future coordinator | DEFERRED | Outside six-hour MVP target |

Future owner roles use the affordable model selected by the user. Historical D-02/D-05 Astra ownership is retained as evidence only. No automatic upgrade or Astra escalation.

Statuses: `TODO`, `READY`, `IN_PROGRESS`, `REVIEW`, `DONE`, `BLOCKED`, `OPTIONAL`, `DEFERRED`. Verification results use `PASS`, `FAIL`, `PARTIAL`, `NOT RUN` separately.

## Claims and ownership

- C-01 claimed 2026-09-12 01:01 UTC by coordinator; owns the onboarding invocation, any necessary local setup artifacts and ledger changes. Verification: CLI outcome, relevant configuration checks and diff review. Existing product/authority contracts remain frozen; no general I-01 resumption implied.
- I-01 claimed 2026-09-12 01:15 UTC by coordinator for the user-directed Trigger.dev setup. Owned files include package manifest/lockfile, Trigger config/task, tsconfig and `.gitignore` only for this bootstrap; verification is dependency/type/config checks plus local `trigger.dev dev` worker readiness. Trigger dashboard confirmation remains pending user browser sign-in.
- Coordinator: root Markdown guides, product requirements, implementation task plan, validation tooling, ledger integration.
- D-02 claimed 2026-09-12 00:26 UTC; scope and verification sent to Astra `write_architecture`.
- D-03 and D-04 claimed in the same documentation loop by Luna workers with disjoint file ownership.
- No overlapping file edits or parallel package installs. Workers submit their changes and report; the coordinator records completion here.
- D-02/D-03/D-04 delivered in parallel; coordinator integrated scoped corrections. Fresh Astra `final_doc_review` completed D-05 with one required correction pass and a passing scoped rereview. No worker remains assigned to implementation.

## Decisions and rulings

- 2026-09-12: Explicit CopilotKit onboarding request authorizes a bounded setup attempt while the general build remains paused. Follow applicable CLI instructions within Signal's Next.js/npm, read-only inspector and sole OpenRouter route requirements; record unmet application prerequisites honestly.
- 2026-09-12 C-01: Selected the documented built-in CopilotKit agent with Next.js and the existing OpenRouter model choice; the official model-selection page supports a custom OpenRouter provider. Created the default managed project `signal` after offering a naming preference. This establishes account/project access only. Production inspector admission still requires Auth0, tenant-filtered persisted proposals and explicit handling of managed conversation retention; no workplace data was sent for inference or conversation storage.
- 2026-09-12 C-01: User confirmed project name `signal` and explicitly named `.env.local` as the OpenRouter credential source. Copied only its OpenRouter assignment into ignored `.env`, set `.env` mode 0600, and preserved the source. Independent verification compared assignments without displaying values. Credential files and the managed project record were added to the onboarding protection baseline.
- 2026-09-11: User prioritized a four-hour coding target plus two finishing hours over using every partner. No tool is mandatory for judging.
- 2026-09-11: User selected issue creation and progress comments, named Slack approvers, one-workspace MVP before SaaS.
- 2026-09-12: Ruling: use Trigger.dev as the sole task engine and OpenRouter as the sole inference route to OpenAI, reflecting the latest partner request and architecture review. Consequence: deploy task code/secrets to Trigger.dev as well as the Vercel web application.
- 2026-09-12: Ruling: use `tasks.md` as the durable ledger and parallelize disjoint documentation subtasks. This follows the user's coordination instruction and avoids competing skill-generated progress files; the coordinator serializes shared edits.
- 2026-09-12: Ruling: preserve the previously committed `northstar.md` plan as historical reference and expose a pointer to the required canonical `north_star.md`, preventing stale stack decisions from guiding agents.
- 2026-09-12: D-05 ruling: I-01 verifies provider access and a harmless temporary Trigger probe. Application migrations, Slack approval and recovery are accepted by I-02/I-03/I-05/I-06 after implementation. Missing code is not an external access blocker.

- 2026-09-11 stop instruction: finish documentation today and use a more affordable model tomorrow. Updated active agent guides and future task roles; retained completed Astra review as historical evidence. I-01 stays unclaimed and its clock stays unset.

## Blockers

- **B-CPK-01 — RESOLVED:** The user supplied `.env.local` as the authorized source. Both `OPENROUTER_API_KEY` and `CPK_INTELLIGENCE_API_KEY` are now verified nonempty in ignored `.env`; the original source is preserved. No secret values were printed.
- **B-CPK-02 — C-01 BLOCKED on implementation dependencies:** The installation planner cannot produce a contract-compliant real round trip in the documentation-only repository. Next.js runtime, Auth0/session-to-tenant mapping and tenant-scoped persisted proposals do not exist; Auth0 and database credentials are also absent from the supplied source. This is an unimplemented dependency, not a provider outage or unsupported OpenRouter route. Required next state: resume the implementation sequence and satisfy the documented O-01/O-02 admission prerequisites. Do not substitute an unauthenticated endpoint or fake proposal. Next ready general task remains I-01, unclaimed until user resumption.
- Other core application credentials and live integrations remain **NOT VERIFIED**. Vercel CLI login does not prove a Signal deployment or service integration. C-01 is scoped onboarding and does not resume I-01.

## Evidence log

- 2026-09-12 C-01: **PASS** — requested `npx --yes copilotkit@latest onboard start --run bc2e0ea2a80e` under Node `v24.20.0`; resolved CLI `4.9.60`, exit 0. Subsequent onboarding commands pinned to that version and run from this repository.
- 2026-09-12 C-01: **PASS** — `copilotkit login --json` emitted `completed` after user browser sign-in. External operations: CLI identification/checkpoint/classification and creation of managed project `signal` with its project API key. No deployment or workplace messages.
- 2026-09-12 C-01: **PASS** — `copilotkit project select --create signal --json` exited 0 and reported project selection, key provisioning, project-record write and environment-file write complete. Independent Luna check confirmed nonempty project identifiers, matching slug and managed key without printing values. `.env` is ignored and untracked.
- 2026-09-12 C-01: **PASS** — read-only project/environment research confirmed a documentation-only repository, the single root app target, Node 24/npm and available port 3000. Browser preflight opened and read `about:blank`. CopilotKit protection captured the pre-existing ledger edit; subsequent coordinator ledger updates are intentional under AGENTS ownership.
- 2026-09-12 C-01: **PASS** — independent setup review verified both nonempty keys, equivalent source/target OpenRouter assignments, both environment files ignored/untracked, matching project fields, no unexpected app/package/lock files, `git diff --check` and `python3 scripts/check_docs.py`. Tracked changes are ledger-only; `.copilotkit/project.json` is a new local managed-project binding. No commit/push/deployment.
- 2026-09-12 C-01: **PARTIAL** — installation planning confirmed the official Next.js/built-in/OpenRouter path but stopped on B-CPK-02. Followed the CLI unsupported-path stop procedure for unmet project prerequisites; this does not mean CopilotKit lacks OpenRouter support.
- 2026-09-12 C-01: **FAIL** — CLI stop-feedback delivery: telemetry transport did not accept the event. Setup results are unchanged; no automatic retry or recurring work was scheduled.
- 2026-09-12 C-01: **NOT RUN** — application scaffolding, dependency install in the project, Auth0/tenant integration, model request, managed conversation round-trip and app/browser acceptance. Integration awaits B-CPK-02; project/key provisioning is not a demonstrated product integration.
- 2026-09-12 I-01: **PASS** — `npx trigger.dev@latest init -p proj_cehggonaqopuuhibihif` completed after user Trigger login; created `trigger.config.ts` with project reference, Node 24 runtime, `maxDuration: 3600`, and `dirs: ["./src/trigger"]`; created exported `helloWorldTask` using `task()` and `wait.for()`.
- 2026-09-12 I-01: **PASS** — added `@trigger.dev/sdk@4.5.16`, `@trigger.dev/build@4.5.16`, and TypeScript to npm manifest/lockfile; `tsconfig.json` includes `trigger.config.ts` and `src/**/*.ts`; `.gitignore` contains `.trigger/`; `npx tsc --noEmit` exited 0; `git diff --check` exited 0.
- 2026-09-12 I-01: **PARTIAL** — `npx trigger.dev@latest dev --profile default` built the local worker and reported `Local worker ready on branch: default [node-24] -> 20260912.1`; dashboard task listing requires user browser sign-in and has not yet been visually confirmed. No `TRIGGER_SECRET_KEY` was added or printed.
- 2026-09-12: **PASS** — Added the documented `EXA_API_KEY=` variable to the ignored `.env` without inventing or printing a key. `EXA_API_KEY` is present but empty; `ENABLE_EXA` remains disabled until a real credential and the separate initiating-Slack-actor consent flow are implemented.
- 2026-09-12: Starting repository contained `.git/` and committed `northstar.md`; base commit `94a51e7`. Working tree was clean.
- 2026-09-12: Created local branch `codex/signal-execution-pack` in the user-requested checkout.
- 2026-09-12: `vercel whoami` exited 0. CLI reported 59.11.2 and local Node.js 26.7.0; target runtime remains Node.js 24.
- 2026-09-12: **PASS** — `python3 scripts/check_docs.py`: 23 required files and 23 Markdown documents; local links, titles, requirement coverage, partner coverage, configuration example and environment names checked.
- 2026-09-12: **PASS** — `git diff HEAD --check`; inspected delivery-file whitespace and common secret patterns; verified original attachment and committed prior-plan content preserved beneath historical banners. This is a limited content inspection, not an application security audit.
- 2026-09-12: **PASS** — independent Astra documentation review and scoped correction review in D-05. Resolved bootstrap/application dependency cycle, clarified Exa consent identity, and corrected demo invocation order.
- 2026-09-12: **NOT RUN** — application build, unit/database/evaluation/browser tests, provisioning, deployments, or live Slack/GitHub/OpenRouter/Trigger acceptance. No application code or dependencies have been installed by this documentation task. No outbound workplace messages or GitHub mutations were sent.
- 2026-09-11 closeout: **PASS** — final documentation checker, current working-tree whitespace check, model-routing consistency check, and bounded Luna bootstrap audit. Handoff added; no automatic Astra routing remains in active instructions. No implementation workers or overnight continuation are assigned. Local documentation checkpoint only; no remote push or deployment.

## Resume instruction

When the user resumes, read [HANDOFF.md](docs/HANDOFF.md) first. D-01 through D-05 are complete. Use the selected affordable model, not an automatic Astra fallback. Read I-01 in [docs/superpowers/plans/2026-09-11-signal.md](docs/superpowers/plans/2026-09-11-signal.md), claim its runtime/access scope, start the implementation clock once, execute, verify, and update this ledger. Continue with independent contract work when an established access blocker prevents a provider check. Do not repeat completed planning research or claim application readiness from this document package.
