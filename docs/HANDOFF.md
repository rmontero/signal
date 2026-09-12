# Signal handoff for the next session

The user stopped work on 2026-09-11 after the documentation milestone. Resume only when asked. [tasks.md](../tasks.md) is the sole status ledger; this file is a restart guide, not another task board.

## Read only what the next task needs

Read [north_star.md](../north_star.md), [roadmap.md](../roadmap.md), [tasks.md](../tasks.md), and [AGENTS.md](../AGENTS.md). For the first task, read only I-01 in the [implementation plan](superpowers/plans/2026-09-11-signal.md) and the [infrastructure guide](INFRASTRUCTURE.md). Consult [CONTRACTS.md](CONTRACTS.md) before shared types or business behavior. Do not restart planning or load every historical reference/review into each worker.

## Checkpoint facts

- Work directory: `/Users/robcr/Projects/signal`; branch: `codex/signal-execution-pack`. Inspect the actual working tree before changing it; preserve newer user edits.
- M0 architecture, infrastructure, contracts, agent rules, integration matrix, verification plan and demo are written. The [Astra documentation review](reviews/D-05.md) passed after one correction.
- Application code, dependencies, migrations, service provisioning and live integration tests have not been implemented by this documentation phase. The four-hour coding clock has **not started**; two finishing hours remain reserved.
- `vercel whoami` previously succeeded. This proves neither a linked Signal project nor provider access. Node was 26.7.0 locally; the project target is Node 24. Recheck versions during bootstrap.
- Credentials are unverified, not known absent. `.env.example` and `config/pilot.example.json` contain placeholders. Local credentials/configuration belong in ignored files; never print their values.

## First task: I-01, in small steps

On resumption, record the implementation start once in tasks.md. All four substeps below share I-01's 30-minute target; the budget does not restart at each substep. Record substep progress in the existing I-01 ledger entry.

1. **Inspect and bootstrap.** Run `git status --short`, `python3 scripts/check_docs.py`, `node --version`, and `npm --version`. Establish Node 24, scaffold the minimal Next.js/TypeScript app without overwriting documents, and pin compatible dependencies in one npm lockfile. Only the coordinator installs packages.
2. **Validate configuration.** Implement the documented core/optional environment checks and intended command surface. Missing optional keys keep features disabled. Do not import the example pilot mapping as a real tenant; verify all IDs first. Actual PostgreSQL import belongs to I-02 after migrations. Missing future test suites must not pass as zero tests.
3. **Check actual provider access.** Follow only INFRASTRUCTURE's I-01 section: database connection/harmless rollback; Slack full-thread read; GitHub granted permissions and repository reads; a data-free Trigger probe; one synthetic structured response through OpenRouter. Verify Trigger CLI login/deployment access separately from its runtime secret; choose the intended deployment environment explicitly. Reuse authorized resources. Do not create a temporary GitHub write or approval bypass. Pending application migrations, durable ingress, approval and recovery are later tasks, not access blockers.
4. **Verify and report.** Run the available typecheck/build/preflight checks, record each real result, and obtain a scoped review. If access is blocked, post one stable blocker with the exact missing input; continue independent I-02 contract work when the runtime is ready. Do not begin optional UI/search while the core is incomplete.

## Working with an affordable model

Use the model selected by the user tomorrow. No automatic Astra dispatch or escalation. Keep tasks narrow and use one coordinator plus a useful independent worker; all workers have disjoint files. Each brief must name inputs, owned files, behavior, tests and a stopping point. The coordinator serializes tasks.md and shared-interface changes. A fresh reviewer may use the same affordable model in a separate context. After two unsuccessful repairs, record the smallest unresolved issue once and work on another ready item; never bypass a failed check.

The reviewed stack is Next.js/Node 24, Vercel, Neon/Drizzle, Trigger.dev and OpenRouter routing OpenAI. Auth0/CopilotKit, Exa, Ambiguous AI and Mozilla.ai are optional in that order. Partner count cannot displace the core or the final two hours. The application runtime model is independent of tomorrow's Codex model selection.

Keep these invariants visible during critical work:

- Slack named-actor approval binds the exact persisted mutation, tenant, target, version/hash and expiry. The model cannot approve or write.
- GitHub writes are issue creation and progress comments only.
- Business jobs carry IDs only; every data relationship and lookup enforces tenant ownership.
- Event/outbox, approval/outbox and result/notification persistence are atomic.
- A duplicate `SENDING` worker never posts. Recovery requires both an expired lease and a terminal owning attempt. An absent marker leaves `UNKNOWN`; it never permits reposting.
- Source text, prompts and credentials never enter logs or task metadata. Fixtures never masquerade as live provider evidence.

## Resume prompt

> Resume Signal in `/Users/robcr/Projects/signal` using the currently selected affordable model. Read `docs/HANDOFF.md` and the canonical guides. Claim the next ready substep of I-01, record the implementation start if still unset, execute and verify it, and update `tasks.md`. Keep coordinated workers small and disjoint. Do not restart architecture planning, spawn Astra, or silently weaken approval, tenant or recovery rules. Post a genuine blocker once and continue independent ready work.
