# Signal agent instructions

## Start every loop

1. Read `north_star.md`, `roadmap.md`, and the current ready/claimed rows of `tasks.md`.
2. Pick the single highest-leverage ready task. Respect dependencies and the feature-freeze clock.
3. Claim it with task ID, owner, scope, start time, and expected verification. One active task per worker.
4. Execute only its owned files. Ask the coordinator before changing a shared contract or another worker's files.
5. Run the relevant verification, obtain review, and update `tasks.md` with evidence and the next ready task.
6. Continue while authorized ready work remains, unless the user has paused work. The 2026-09-11 stopping instruction leaves I-01 unclaimed until the user resumes. Do not request routine permission between tasks after resumption.

## Coordination

- The coordinator owns `tasks.md`, the shared contract, dependency/lock files, and final integration. Workers send ledger updates to the coordinator; they may write only their assigned report under `docs/reviews/` to avoid ledger races.
- Two-track operating mode: Rob is the coordinator/integration owner; Cesar is the separate-checkout implementation owner for the downstream Slack/GitHub interaction and optional inspector tasks assigned in `roadmap.md` and `tasks.md`. Cesar does not edit `tasks.md`, shared contracts, product docs, or package/lock files. He hands off the task ID, changed files, commit/hash, verification evidence, blockers, and next dependency; Rob integrates and records the ledger update.
- Use `codex/signal-track-rob` and `codex/signal-track-cesar` as the track branches. Each session starts from the latest integrated state. A track pauses when its dependency or interface is not frozen; do not invent a parallel contract or duplicate status ledger.
- Model policy updated 2026-09-11: Astra's planning/review work is finished. Tomorrow use the affordable model selected by the user for coordination and implementation. Do not automatically spawn, resume, or escalate to Astra; only a new explicit user request re-enables it.
- Use the selected affordable model for workers, or Luna for bounded supporting work when available. A task's owner role does not require a more expensive model. Historical Astra delivery reports remain evidence, not future routing instructions.
- Use small task briefs instead of full conversation forks: task/substep, exact owned files, frozen interfaces, expected behavior, focused checks, and stopping condition. Workers do not spawn workers. Start with one coordinator and one useful independent worker; add another only for disjoint ready work. The coordinator alone edits shared contracts, package files and the ledger.
- Parallel work is allowed on disjoint owned files with frozen interfaces. Dependent changes and package installs are sequential. A highest-leverage parent task may have independently owned subtasks.
- Implement one verifiable substep at a time. For authorization, tenant isolation, database transactions and mutation recovery, use focused failure tests plus a fresh-context reviewer on the selected affordable model. Prefer one review and a scoped correction review. After two unsuccessful repairs, record the error, attempted fixes and smallest unresolved decision once; continue independent work. Do not weaken the contract or start an expensive model to get unstuck.
- Record any necessary scope/contract ruling and its consequence in `tasks.md`. User decisions override generic skill workflows.
- `tasks.md` is the sole durable execution ledger. Do not create competing status files, autonomous recurring jobs, or a second task board.

## Blockers

Record a stable blocker ID, affected tasks, evidence, and the specific input/state needed. Post it to the user once. Reuse the same blocker entry until it changes; work on independent ready tasks. Missing credentials do not justify fake successful integrations or repeated status messages.

## Product boundaries

- Use Trigger.dev, not Vercel Workflows, for background jobs. Use OpenRouter to the selected OpenAI model, not a parallel Gateway route.
- Slack is the only authority surface for MVP GitHub approvals. Auth0 login and CopilotKit UI do not grant GitHub write authority.
- Only `CREATE_ISSUE` and `ADD_PROGRESS_COMMENT` are allowed GitHub writes. No PATCH, closure, merges, deployments, or silent owner guessing.
- Review exact persisted payloads. Handle `UNKNOWN` writes through reconciliation; never retry them blindly.
- Tenant context must be explicit in data access and verified on task execution. Browser inputs and model output are untrusted.
- Do not log secrets, raw source text, complete prompts, or task payload contents. Use IDs, hashes, durations, and small status values.
- Keep optional integrations disabled unless configured. A successful installation alone does not count as demonstrated use.

## Working conventions

- Work in `/Users/robcr/Projects/signal`; use a `codex/` branch. Preserve user changes and historical reference documents.
- Use Node.js 24, TypeScript, npm, one Next.js repository, and one lockfile. Pin compatible package versions when bootstrapping; consult installed-version documentation for SDK APIs.
- Prefer `rg` for searches. Avoid broad dependency updates, separate services, and unrelated refactoring.
- Tests must verify behavior and failure boundaries. No tests for trivial documentation edits; use link/contract checks for the documentation package.
- Report `PASS`, `FAIL`, `PARTIAL`, or `NOT RUN` with commands and evidence. A build, unit test, mock, and real integration smoke test are different kinds of evidence.
- Do not commit, push, deploy, send messages, or buy resources beyond the user's existing authorization. Do not ask again when the current task already authorizes the concrete action; record meaningful external operations.

## Documentation precedence

Latest user instructions → `north_star.md` → `docs/PRODUCT.md` and `docs/CONTRACTS.md` → architecture/infrastructure → implementation task details. Update disagreements before executing dependent work. Files under `docs/reference/` are historical evidence only.
