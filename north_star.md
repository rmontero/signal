# Signal north star

Turn an explicitly invoked workplace conversation into one reviewable, evidence-backed GitHub action, and execute that exact action only after an authorized human approves it.

## Success

In a real Slack thread, `@Signal` identifies decisions, tasks, owners, blockers, and deadlines; retrieves related GitHub issues and pull requests; presents an exact draft; and creates an issue after a named Slack approver accepts. A subsequent progress update produces an approved comment on that issue. Replaying delivery or approval does not duplicate either write.

The demonstration takes less than two minutes under normal, non-rate-limited conditions. Code complete is a four-hour implementation target followed by two protected hours for verification, polish, the demo, and documentation. This is a planning budget, not a guarantee about service setup or account access.

## Priority order

1. Working Slack → approved GitHub issue/comment flow.
2. Correct authorization, evidence, and recovery from uncertain writes.
3. A usable demo and reproducible verification.
4. Meaningful partner integrations within the remaining time.
5. Multi-tenant SaaS expansion after the MVP gate.

## Locked decisions

- One Next.js App Router/TypeScript repository, Node.js 24, npm, Vercel hosting, Neon PostgreSQL, and Drizzle.
- Trigger.dev is the only background task engine. It replaces the earlier Vercel Workflows design.
- OpenRouter routes the selected OpenAI model, initially `openai/gpt-5.6-luna`. It replaces the earlier Vercel AI Gateway route. Keep one provider adapter; no duplicate inference solely to count vendors.
- One manually configured Slack workspace for the MVP, allowlisted non-shared channels, and one repository mapping per channel.
- Slack mentions are the only ingestion trigger. No continuous monitoring, slash commands, calendar, email, Teams, billing, or production code changes.
- GitHub writes are `CREATE_ISSUE` and `ADD_PROGRESS_COMMENT`. Updating an issue means adding a comment, not changing its existing title/body/state/assignees.
- Named Slack approvers use delegated GitHub App authority. This does not claim that a Slack identity has individual GitHub permission.
- Auth0 and CopilotKit form an optional, read-only proposal inspector. Exa is an optional, explicitly approved public-document search.
- Mozilla.ai evaluation and Ambiguous AI runbook retrieval are optional, timeboxed additions. No partner is mandatory. Count only demonstrated usage.

## Non-negotiable invariants

- The model never owns a GitHub write tool or an approval transition.
- Approvals bind the tenant, target, exact immutable payload, version/hash, named actor, and 30-minute expiry.
- Derive tenant identity from a verified installation or an explicitly mapped authenticated subject. Never trust client-supplied tenant identity.
- Every tenant-owned relationship and uniqueness constraint includes the tenant. Missing tenant context fails closed.
- Persist accepted events and dispatch jobs atomically. Persist GitHub results and Slack notification jobs atomically.
- A crash or uncertain GitHub response enters `UNKNOWN`; reconcile a stable operation marker before any further action. Absence of a match never justifies automatic reposting.
- Keep source text and credentials out of logs and task metadata. Provider retention is a separate concern from application cleanup.
- Never invent an owner, deadline, link, integration success, or test result.

## Agent operating instruction

Read this file, [roadmap.md](roadmap.md), and [tasks.md](tasks.md). Pick the single highest-leverage ready step toward this goal, claim its bounded scope, execute it, verify it, and update `tasks.md`. Post a blocker once if genuinely stuck; record its required resolution and continue independent work.

Astra completed the initial architecture and documentation review. Per the 2026-09-11 stopping instruction, future implementation uses the affordable model selected by the user; no automatic Astra dispatch or escalation. The coordinator assigns small, disjoint tasks, preserves the reviewed interfaces, and maintains the ledger. Critical behavior still requires failure tests and independent review. These development model choices are independent of the application's runtime model.

## Canonical documents

[AGENTS.md](AGENTS.md) defines coordination; [docs/PRODUCT.md](docs/PRODUCT.md) defines behavior; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/CONTRACTS.md](docs/CONTRACTS.md) define implementation; [tasks.md](tasks.md) is the sole status ledger. Historical briefs do not override these decisions.
