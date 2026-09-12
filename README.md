# Signal

Turn conversation into action.

Signal is a Slack-first coordination agent. It turns an explicitly invoked thread into an evidence-backed GitHub issue or progress comment, with a named human approving the exact payload before execution.

## Start here

**Resuming after the 2026-09-11 stop:** use the [compact handoff](docs/HANDOFF.md). Documentation is complete; bootstrap is next. Future work uses the user's selected affordable model without automatic Astra escalation.

1. [North star](north_star.md): outcome, priority order, constraints.
2. [Roadmap](roadmap.md): four-hour coding target plus two protected finishing hours.
3. [Tasks](tasks.md): current work, ownership, evidence, blockers and next action.
4. [Agent instructions](AGENTS.md): coordinated execution loops and model roles.

## Implementation package

| Document | Read when |
|---|---|
| [Handoff](docs/HANDOFF.md) | Resuming tomorrow with a small first task and the reviewed decisions |
| [Product](docs/PRODUCT.md) | Understanding exact MVP behavior and acceptance requirements |
| [Architecture](docs/ARCHITECTURE.md) | Understanding components and trust boundaries |
| [Contracts](docs/CONTRACTS.md) | Implementing shared types, persistence and state transitions |
| [Infrastructure](docs/INFRASTRUCTURE.md) | Provisioning services and configuring environments |
| [Implementation plan](docs/superpowers/plans/2026-09-11-signal.md) | Claiming the next bounded coding task |
| [Integrations](docs/INTEGRATIONS.md) | Adding or verifying a partner capability |
| [Verification](docs/VERIFICATION.md) | Running focused checks and release acceptance |
| [Operations](docs/OPERATIONS.md) | Recovering failures, rotating access or rolling back |
| [Demo](docs/DEMO.md) | Preparing and rehearsing the live demonstration |
| [SaaS](docs/SAAS.md) | Planning the post-MVP multi-tenant release |

## Current state

This repository contains the autonomous implementation package. Application implementation and live integration verification have their own tasks; see [tasks.md](tasks.md) for the authoritative status. Documentation checks do not prove a running application.

Run the dependency-free documentation check:

```sh
python3 scripts/check_docs.py
```

Application setup and npm commands are defined in the implementation plan and become available when I-01 is implemented. The target runtime is Node.js 24. Configuration names are documented in [the infrastructure guide](docs/INFRASTRUCTURE.md). Copy [.env.example](.env.example) to `.env.local` and [pilot.example.json](config/pilot.example.json) to `config/pilot.local.json` during preflight, replacing placeholders with verified values. The example is intentionally not valid deployment configuration. Never put actual secrets in Markdown or commit local configuration.

The earlier saved plan is preserved in [historical reference](docs/reference/prior-plan.md), and the supplied product brief is preserved [here](docs/reference/original-brief.md). Current decisions replace that plan's Vercel Workflows/Gateway choices with Trigger.dev/OpenRouter.
