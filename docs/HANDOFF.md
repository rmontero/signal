# Signal handoff for the next session

The documentation milestone is complete and the user-directed implementation resumed on 2026-09-12. [tasks.md](../tasks.md) is the sole status ledger; this file is a restart guide, not another task board.

## Read only what the next task needs

Read [north_star.md](../north_star.md), [roadmap.md](../roadmap.md), [tasks.md](../tasks.md), and [AGENTS.md](../AGENTS.md). For the first task, read only I-01 in the [implementation plan](superpowers/plans/2026-09-11-signal.md) and the [infrastructure guide](INFRASTRUCTURE.md). Consult [CONTRACTS.md](CONTRACTS.md) before shared types or business behavior. Do not restart planning or load every historical reference/review into each worker.

## Checkpoint facts

- Work directory: `/Users/robcr/Projects/signal`; inspect the actual branch and working tree before changing it; preserve newer user edits.
- M0 architecture, infrastructure, contracts, agent rules, integration matrix, verification plan and demo are written. The [Astra documentation review](reviews/D-05.md) passed after one correction.
- MVP application slices, dependencies, migrations, observer/approval/recovery routes and dashboard exist. The release audit reopened I-06 after finding gaps not covered by the earlier passing checks. Recovery corrections are locally verified; dispatched-job execution/retry recovery still needs completion. Production routes were deployed before these corrections. Live signed provider delivery, real tenant mapping and GitHub create/comment/replay remain incomplete as recorded in `tasks.md`.
- `vercel whoami` previously succeeded. This proves neither a linked Signal project nor provider access. Node was 26.7.0 locally; the project target is Node 24. Recheck versions during bootstrap.
- Credentials are unverified, not known absent. `.env.example` and `config/pilot.example.json` contain placeholders. Local credentials/configuration belong in ignored files; never print their values.

## Current next step: finish I-06 release corrections, then V-01

The implementation clock started at 2026-09-12 01:15 UTC and is not restarted. Record new evidence in `tasks.md`; do not relabel missing live provider evidence as a local pass.

1. Finish the I-06 review and dispatched-job execution/retry recovery. Preserve verified owner terminality, exhausted leases, fencing, stable global dispatch keys and read-only UNKNOWN recovery. Legacy uncertain operations without owner/lease evidence require manual investigation, never fabricated proof or a repost.
2. Fill verified IDs in ignored `config/pilot.local.json` and the Vercel/Trigger runtime stores; never copy the example IDs. Run `npm run pilot:import` and verify counts/IDs without exposing secrets.
3. Deploy the accepted corrections to both runtimes, register the documented Slack/GitHub URLs, then exercise signed observer delivery and both approved GitHub action paths in a disposable mapped workspace/repository.
4. Record real Trigger/OpenRouter classification, response-loss/reconciliation and demo evidence. Keep optional features disabled unless their own acceptance evidence is complete.

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

> Resume Signal in `/Users/robcr/Projects/signal` using the currently selected model and affordable supporting workers. Read `docs/HANDOFF.md`, `roadmap.md`, `tasks.md`, and the canonical contracts. Finish the reopened I-06 recovery work and its independent review before the V-01 live gate. Then import only verified pilot IDs, exercise signed Slack/GitHub delivery and both approved GitHub actions in the authorized disposable environment, and record evidence in `tasks.md`. Preserve existing work and keep optional features disabled until demonstrated; do not restart architecture planning or weaken authority/recovery requirements.
