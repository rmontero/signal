# Signal hackathon onboarding

Signal is a Slack-first coordination agent for engineering teams. It turns an explicitly invoked workplace conversation into an evidence-backed GitHub issue or progress comment. Signal extracts decisions, tasks, owners, blockers, deadlines and supporting repository context, then presents the exact proposed action for approval by a named Slack approver before any GitHub write occurs.

This document is intended for private sharing with hackathon teammates. It contains no credentials. Share secrets through the provider dashboard or an approved secret manager, never in Slack, a repository issue, a commit, or this document.

## What we are building

The primary path is:

`Talacha.dev Slack mention → complete thread context → grounded proposal → Slack review → named approval → one GitHub issue or progress comment`

Signal keeps the source conversation, proposal, approval, operation state and external result linked by tenant and immutable identifiers. Replayed events and uncertain provider responses must not create duplicate GitHub writes.

Slack is the only approval authority for the MVP. The web inspector, CopilotKit, Exa, Ambiguous and Mozilla.ai are optional supporting capabilities. None of them can approve, dispatch, edit or write to GitHub.

## Runtime and services

- One Next.js App Router and TypeScript repository running on Node.js 24 with npm.
- Neon PostgreSQL with Drizzle for tenant-scoped application state, proposals, approvals, operations and outbox records.
- Trigger.dev for background jobs and recovery tasks. The project reference is `proj_cehggonaqopuuhibihif`.
- OpenRouter as the single model route to the selected OpenAI model, initially `openai/gpt-5.6-luna`.
- Talacha.dev Slack workspace for mentions, thread reads, review cards and notifications.
- A GitHub App installed only on selected repositories, with issue creation and progress-comment capability bounded by the approval flow.
- Optional Auth0 plus CopilotKit read-only proposal inspection.
- Optional Exa search for separately approved, sanitized public-document queries.
- Optional Ambiguous read-only runbook context in its dedicated workspace.
- Optional Mozilla.ai offline evaluation on synthetic fixtures only; it is not a production runtime service.

## Before coding

1. Use Node.js 24 and npm. Confirm the repository branch and inspect the working tree before editing.
2. Copy `.env.example` to an ignored `.env` and populate only the values you are authorized to use. Never print the file or commit it.
3. Complete the required core environment settings in [`docs/INFRASTRUCTURE.md`](INFRASTRUCTURE.md): application URL, Neon connections, Trigger project and secret, Slack signing secret and bot token, GitHub App credentials, OpenRouter key/model, maintenance secret and pilot-config path.
4. Create a local `config/pilot.local.json` from the example only after verifying every tenant, Talacha channel, GitHub repository, approver and identity mapping. Do not treat the example IDs as real configuration.
5. Keep the Ambiguous agent credential in the project-local `.ambi/config.json`; do not copy it into source or a second integration variable.
6. Run the documented access checks: database transaction and rollback, data-free Trigger probe, permitted Slack thread pagination, GitHub read/permission checks and one bounded structured OpenRouter response using synthetic text.
7. Do not enable optional integrations until their own acceptance checks pass. Keep `ENABLE_INSPECTOR`, `ENABLE_EXA` and `ENABLE_AMBIGUOUS` set to `false` by default.

The environment names and readiness gates are maintained in [`.env.example`](../.env.example) and [`docs/INFRASTRUCTURE.md`](INFRASTRUCTURE.md). A populated env file, package install or CLI login alone does not prove integration access.

## Working agreements

- Read [`north_star.md`](../north_star.md), [`roadmap.md`](../roadmap.md), [`tasks.md`](../tasks.md) and [`AGENTS.md`](../AGENTS.md) before taking a task.
- `tasks.md` is the sole execution ledger. Claim one bounded task with scope, owner, start time and verification evidence.
- Preserve the reviewed contracts in [`docs/CONTRACTS.md`](CONTRACTS.md). Ask the coordinator before changing shared interfaces, package files or the ledger.
- Keep task payloads ID-only. Workers load tenant-owned records from the database and recheck tenant context when executing.
- Never log source text, prompts, complete payloads, credentials, callback bodies or tokens. Record IDs, hashes, durations and small status values.
- The model has read and extraction authority only. It cannot approve a proposal or own a GitHub write.
- Allowed GitHub writes are `CREATE_ISSUE` and `ADD_PROGRESS_COMMENT`. Do not add issue patching, closure, merges, deployments or silent owner selection.
- An uncertain GitHub response becomes `UNKNOWN` and is reconciled using a stable marker. Absence of a marker never authorizes a blind retry.
- Do not send workplace messages, create GitHub issues/comments, deploy, or change external configuration unless the task explicitly authorizes that operation.

## Task sequence

Work through the dependency chain in order:

1. **I-01:** bootstrap the runtime and prove core provider access.
2. **I-02:** implement PostgreSQL contracts, tenant isolation, inbox/outbox and operation state transitions.
3. **I-03:** implement signed Slack mention intake, complete thread reads and durable analysis dispatch.
4. **I-04:** implement grounded OpenRouter extraction, bounded GitHub retrieval and immutable proposals.
5. **I-05:** implement Slack review, named-actor approval and deterministic GitHub issue/comment execution.
6. **I-06:** implement reconciliation, recovery dispatch and Slack result delivery.
7. **V-01/V-02:** run failure/security checks, deployed acceptance, accessibility polish and the demo rehearsal.
8. **Optional work:** Auth0/CopilotKit, Exa, Ambiguous and Mozilla.ai only after the core gate and within their timeboxes.

## Definition of done for the hackathon

The demo is ready when a real Talacha Slack mention produces one grounded proposal, the named approver can approve the exact persisted payload, one authorized GitHub issue or progress comment is created, the result appears back in Slack, and replay/recovery checks show no duplicate write. Tenant-mismatch, wrong-actor, expired-approval, changed-payload and uncertain-write cases must fail safely.

## Current handoff

The repository currently contains the architecture and setup notes plus local provider bootstrap artifacts. Confirm the active branch and working tree before relying on any local setup. If the application source or task ledger is absent, resume the implementation package from the canonical guides rather than inventing a parallel structure. Record the actual state and blockers in `tasks.md` when that ledger is present.

For help, start with the canonical [infrastructure guide](INFRASTRUCTURE.md), [contracts](CONTRACTS.md), [verification matrix](VERIFICATION.md), [operations runbook](OPERATIONS.md), and [demo guide](DEMO.md).
