# Signal hackathon onboarding

Signal is a Slack-first coordination agent for engineering teams. It observes signed messages in allowlisted, non-shared Slack channels and GitHub pull-request events from mapped installations. An explicit Slack mention starts an evidence-backed proposal; a named Slack approver must review the exact persisted action before an issue or progress comment can be written.

This document is intended for private sharing with hackathon teammates. It contains no credentials. Share secrets through the provider dashboard or an approved secret manager, never in Slack, a repository issue, a commit, or this document.

## What we are building

The primary path is:

`Talacha.dev Slack mention → complete thread context → grounded proposal → Slack review → named approval → one GitHub issue or progress comment`

Signal keeps the source conversation, proposal, approval, operation state and external result linked by tenant and immutable identifiers. Replayed events and uncertain provider responses must not create duplicate GitHub writes.

Passive observation is a separate initial setup stage: verified event → persisted coordinates/hash and outbox job → bounded read/classification → dashboard. It can send retrieved content to the configured OpenRouter model, but cannot create a proposal, post a Slack reply, or write to GitHub by itself. Receiving an event and completing classification are separate acceptance checks.

Slack is the only approval authority for the MVP. The web inspector, CopilotKit, Exa, Ambiguous and Mozilla.ai are optional supporting capabilities. None of them can approve, dispatch, edit or write to GitHub.

## Runtime and services

- One Next.js App Router and TypeScript repository running on Node.js 24 with npm.
- Neon PostgreSQL with Drizzle for tenant-scoped application state, proposals, approvals, operations and outbox records.
- Trigger.dev for background jobs and recovery tasks. The project reference is `proj_cehggonaqopuuhibihif`.
- OpenRouter as the single model route to the selected OpenAI model, initially `openai/gpt-5.6-luna`.
- Talacha.dev Slack workspace for mentions, thread reads, review cards and notifications.
- A GitHub App installed only on selected repositories. Start with Pull requests read and Metadata read for observation; grant Issues write only when setting up the approved action flow.
- Optional Auth0 plus CopilotKit read-only proposal inspection.
- Optional Exa search for separately approved, sanitized public-document queries.
- Optional Ambiguous read-only runbook context in its dedicated workspace.
- Optional Mozilla.ai offline evaluation on synthetic fixtures only; it is not a production runtime service.

## Local development

1. Use Node.js 24 and npm. Confirm the repository branch and inspect the working tree before editing.
2. Preserve existing ignored `.env` and `.env.local` files. Use [`.env.example`](../.env.example) as a reference and add only authorized settings needed for current work; leave future core names unset. Never print or commit values.
3. Run `npm run preflight`. Default scope is the recognized names actually supplied by the shell, `.env`, and `.env.local`. A supplied core name with an empty, whitespace-only, or recognized placeholder value fails; an absent name is deferred. Correct or unset an unused placeholder. Missing optional values do not fail this check.
4. Continue local implementation and focused synthetic tests even when provider setup is incomplete. An empty scope is reported as such; passing preflight does not establish connectivity, valid credentials, a working mapping, or release readiness.
5. Keep `ENABLE_INSPECTOR`, `ENABLE_EXA` and `ENABLE_AMBIGUOUS` false until their implementations and acceptance checks exist. An optional flag or token alone does not enable a working integration. The project-local `.ambi/config.json` credential is separate from application configuration.

`npm run preflight -- --strict` (or `SIGNAL_PREFLIGHT_STRICT=1`) explicitly checks the full 16-name release configuration checklist. It includes local operator inputs as well as web/task inputs; it is not a requirement to copy every secret into every runtime. Both modes inspect configuration locally and print only names/counts/statuses. The [infrastructure guide](INFRASTRUCTURE.md) defines the runtime split and separate live gates.

## Connecting the pilot

Start with passive observation using the [exact Slack/GitHub setup](INFRASTRUCTURE.md#passive-observation-setup). The intended ingress URLs are `https://www.sgn.lol/api/slack/events` and `https://www.sgn.lol/api/github/webhooks`. Slack subscribes to `message.channels` for public channels and `message.groups` only for approved private channels. Configure the GitHub App webhook with Pull requests read; a standalone repository webhook lacks the installation binding this implementation requires.

Supply the real workspace, channel, repository and installation IDs in ignored `config/pilot.local.json`, then have the authorized operator import the validated mapping into the intended database. The [server mapping requirements](INFRASTRUCTURE.md#server-pilot-mapping) explain what is actually persisted and what remains unsupported. A JSON file, environment value, installed bot, or dashboard setting alone cannot bind a tenant to incoming events.

For the separately authorized write stage, add Slack `app_mention`/`app_mentions:read`, `chat:write`, and interactivity at `https://www.sgn.lol/api/slack/interactions`; grant the GitHub App Issues write only on the selected repositories. Complete [approved action setup](INFRASTRUCTURE.md#approved-action-setup) and prove exact-payload Slack review before any real create/comment test. Preflight does not perform installation, import, deployment, provider messages, or GitHub writes.

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
3. **I-03:** implement signed Slack/GitHub observer intake, explicit Slack mention intake, complete thread reads and durable dispatch.
4. **I-04:** implement grounded OpenRouter extraction, bounded GitHub retrieval and immutable proposals.
5. **I-05:** implement Slack review, named-actor approval and deterministic GitHub issue/comment execution.
6. **I-06:** implement reconciliation, recovery dispatch and Slack result delivery.
7. **V-01/V-02:** run failure/security checks, deployed acceptance, accessibility polish and the demo rehearsal.
8. **Optional work:** Auth0/CopilotKit, Exa, Ambiguous and Mozilla.ai only after the core gate and within their timeboxes.

## Definition of done for the hackathon

The demo is ready when a real Talacha Slack mention produces one grounded proposal, the named approver can approve the exact persisted payload, one authorized GitHub issue or progress comment is created, the result appears back in Slack, and replay/recovery checks show no duplicate write. Tenant-mismatch, wrong-actor, expired-approval, changed-payload and uncertain-write cases must fail safely.

## Current handoff

The repository contains web routes, a database-backed dashboard, pilot import, Trigger tasks, provider adapters, approval/recovery services and tests. Implementation and configuration are not live acceptance. Read [tasks.md](../tasks.md) for current claims, verification and blockers; verify the deployed web/task versions and real mappings before a live run. Workers hand scoped evidence to the coordinator, who maintains that single ledger.

For help, start with the canonical [infrastructure guide](INFRASTRUCTURE.md), [contracts](CONTRACTS.md), [verification matrix](VERIFICATION.md), [operations runbook](OPERATIONS.md), and [demo guide](DEMO.md).
