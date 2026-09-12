# Signal instructions for Claude Code

Read [AGENTS.md](AGENTS.md) and follow the same coordination rules as every other agent. The canonical goal is [north_star.md](north_star.md), the delivery sequence is [roadmap.md](roadmap.md), and the sole execution ledger is [tasks.md](tasks.md).

At the start of each loop, pick the single highest-leverage ready task, claim its scope through the coordinator, execute it, verify it, and report the ledger update. Post a genuine blocker once. Continue authorized independent work. Do not create a second status file or change another worker's files.

## Current contracts

- Use Next.js, TypeScript, Node.js 24, Vercel, Neon/Drizzle, Trigger.dev, and OpenRouter routing to OpenAI. The earlier Vercel Workflows/Gateway choices are superseded.
- Slack is the only GitHub approval surface. Execute only an approved immutable issue creation or progress comment. Models never approve or write.
- Verify tenant identity and named approver authority on every relevant boundary. An uncertain GitHub write remains `UNKNOWN` until read-only reconciliation proves its result; absence never permits reposting.
- Keep secrets and source text out of logs and task metadata. Optional features remain disabled until configured and verified.
- Follow the current affordable-model policy in AGENTS. Astra's planning is complete; do not spawn or escalate to Astra without a new explicit user request. The runtime model choice is separate from the development model roles.

Implementation details live in [the product specification](docs/PRODUCT.md), [contracts](docs/CONTRACTS.md), and [task plan](docs/superpowers/plans/2026-09-11-signal.md). Files under `docs/reference/` are historical evidence and do not override current decisions.

## Verification

Run `python3 scripts/check_docs.py` to check documentation structure. Application commands become available through I-01; consult the ledger for actual implementation and test evidence. Never infer a passing build, deployment, or integration from the presence of documentation or configuration.
