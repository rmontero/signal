# Signal tasks

This is the sole execution ledger. Read [north_star.md](north_star.md), [roadmap.md](roadmap.md), and [AGENTS.md](AGENTS.md) before selecting work.

## Current step

**STOPPED FOR TODAY — 2026-09-11, at the completed documentation milestone.** No implementation task is claimed. I-01 remains READY for the next user-directed session; use [HANDOFF.md](docs/HANDOFF.md). Do not resume overnight or dispatch Astra automatically.

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
| I-01 | Bootstrap compatible runtime and verify real core integration access | D-05 | Coordinator | READY | Start implementation clock on claim; 30-minute access-preflight budget |
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

- Coordinator: root Markdown guides, product requirements, implementation task plan, validation tooling, ledger integration.
- D-02 claimed 2026-09-12 00:26 UTC; scope and verification sent to Astra `write_architecture`.
- D-03 and D-04 claimed in the same documentation loop by Luna workers with disjoint file ownership.
- No overlapping file edits or parallel package installs. Workers submit their changes and report; the coordinator records completion here.
- D-02/D-03/D-04 delivered in parallel; coordinator integrated scoped corrections. Fresh Astra `final_doc_review` completed D-05 with one required correction pass and a passing scoped rereview. No worker remains assigned to implementation.

## Decisions and rulings

- 2026-09-11: User prioritized a four-hour coding target plus two finishing hours over using every partner. No tool is mandatory for judging.
- 2026-09-11: User selected issue creation and progress comments, named Slack approvers, one-workspace MVP before SaaS.
- 2026-09-12: Ruling: use Trigger.dev as the sole task engine and OpenRouter as the sole inference route to OpenAI, reflecting the latest partner request and architecture review. Consequence: deploy task code/secrets to Trigger.dev as well as the Vercel web application.
- 2026-09-12: Ruling: use `tasks.md` as the durable ledger and parallelize disjoint documentation subtasks. This follows the user's coordination instruction and avoids competing skill-generated progress files; the coordinator serializes shared edits.
- 2026-09-12: Ruling: preserve the previously committed `northstar.md` plan as historical reference and expose a pointer to the required canonical `north_star.md`, preventing stale stack decisions from guiding agents.
- 2026-09-12: D-05 ruling: I-01 verifies provider access and a harmless temporary Trigger probe. Application migrations, Slack approval and recovery are accepted by I-02/I-03/I-05/I-06 after implementation. Missing code is not an external access blocker.

- 2026-09-11 stop instruction: finish documentation today and use a more affordable model tomorrow. Updated active agent guides and future task roles; retained completed Astra review as historical evidence. I-01 stays unclaimed and its clock stays unset.

## Blockers

No blocker has been posted. Core application credentials and live integrations are **NOT VERIFIED**; absence has not yet been established. Vercel CLI login was verified read-only; it does not prove a Signal deployment or any service integration.

## Evidence log

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
