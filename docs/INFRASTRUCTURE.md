# Signal infrastructure and preflight

This is a setup specification. No account, secret, installation, deployment or live smoke test is established by these documents. Work begins through I-01 in [tasks.md](../tasks.md); use the existing authorization boundaries before provisioning or spending.

## Inputs and configuration

Pin compatible versions at bootstrap: Node.js 24, Next.js, React, TypeScript, Drizzle, Neon driver, Trigger SDK/CLI, schema validator and provider clients. Keep one `package-lock.json`. Choose a Neon connection mode supporting interactive transactions and row locks; verify those behaviors against a real database, not an HTTP batch substitute.

## Autonomous-agent pre-flight

An agent may begin autonomous coding only after the configuration below is populated in the intended development environment and the access checks have passed. Use an ignored `.env` for the local runtime; `.env.example` is a names-only template. Keep separate development and production values. Never paste a secret into a prompt, commit it, expose it through `NEXT_PUBLIC_*`, or copy a provider credential into a different provider's variable.

### Required before the first autonomous coding run

| Setting | Required state and verification |
|---|---|
| `APP_BASE_URL` | Canonical local/preview URL reachable by callbacks; verify the health route after boot |
| `SIGNAL_DASHBOARD_TENANT_ID` | Server-only MVP dashboard tenant context; must be an active tenant ID and is never accepted from browser input |
| `DATABASE_URL` | Pooled Neon runtime connection; verify a harmless query and tenant-scoped transaction |
| `DATABASE_URL_UNPOOLED` | Direct Neon migration connection; verify migrations can run separately from pooled access |
| `TRIGGER_PROJECT_REF` | `proj_cehggonaqopuuhibihif`; verify the CLI targets the intended project/environment |
| `TRIGGER_SECRET_KEY` | Development task/API secret from Trigger.dev; verify the task runtime can authenticate without printing it |
| `SLACK_SIGNING_SECRET` | Talacha.dev Slack app signing secret; verify raw-body signature rejection and acceptance |
| `SLACK_BOT_TOKEN` | Talacha.dev installation token with only the documented app scopes; verify identity and permitted channel metadata |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | GitHub App credentials for selected repositories; verify installation/repository reads and granted Issues write/Pull requests read permissions |
| `OPENROUTER_API_KEY` | OpenRouter credential; verify one bounded structured response using the exact model below |
| `OPENROUTER_MODEL` | Exactly `openai/gpt-5.6-luna`; reject silent fallback or a direct OpenAI route |
| `CRON_SECRET` | High-entropy secret for the protected maintenance endpoint; verify missing/wrong bearer is rejected |
| `SIGNAL_PILOT_CONFIG_PATH` | Path to a validated local mapping file; verify tenant, Talacha workspace/channel, repository, approver and identity IDs before import |

The core gate is all required names present, a real database transaction, a data-free Trigger probe, a full permitted Slack thread read, GitHub repository/permission reads, and one schema-valid OpenRouter response. Missing application code is a work item after this gate, not a reason to fabricate provider success.

While implementation is in progress, `npm run preflight` uses the populated development scope only: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `TRIGGER_SECRET_KEY`, `OPENROUTER_API_KEY`, and the currently present optional names. This lets local contract and application work proceed without treating absent future-provider values as a successful live gate. Run `npm run preflight -- --strict` to evaluate the complete required-variable list before enabling autonomous provider execution or release acceptance. Both modes print names and statuses only; neither mode prints secret values.

### Optional settings, enabled only after their own acceptance checks

| Setting | Use and prerequisite |
|---|---|
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` | Read-only proposal inspector. Requires an Auth0 application, registered callback/logout URLs, server-side session verification and persisted subject-to-tenant mapping. |
| `ENABLE_INSPECTOR` | Set `true` only after Auth0 login and unmapped-subject denial pass; otherwise keep `false`. |
| `CPK_INTELLIGENCE_API_KEY` | CopilotKit managed Intelligence project key, separate from model credentials. Enable only when managed thread retention is accepted and the server passes authorized context. |
| `EXA_API_KEY` | Exa public-document search key. Requires exact sanitized-query approval by the initiating Slack actor before every request; maximum three references. |
| `ENABLE_EXA` | Set `true` only after a real approved query returns cited public links; otherwise keep `false`. |
| `AMBIGUOUS_API_KEY` | Optional API token for an allowlisted demo workspace. The agent identity configured by `npx ambiguous@latest auth login` is stored in `.ambi/config.json`, not this variable. |
| `ENABLE_AMBIGUOUS` | Set `true` only after the documented API/schema and a read-only allowlisted retrieval pass; otherwise keep `false`. |
| `SLACK_THREAD_READ_TOKEN` | Separate eligible reader token when the bot token cannot read permitted thread replies; never silently substitute a user token. |
| `TRIGGER_ACCESS_TOKEN` | Noninteractive CLI/CI deployment credential only; never load into application tasks. |

Mozilla.ai has no environment credential in this design. Its evaluator runs offline against synthetic fixtures and must not receive Slack text, credentials, private URLs or production traces. Likewise, the OpenAI Agents SDK uses the existing OpenRouter adapter; do not add `OPENAI_API_KEY` or a second inference gateway.

### Non-env setup that is still mandatory

Store the validated Talacha.dev Slack workspace/channel and GitHub repository mappings in `config/pilot.local.json` (ignored), including named approvers and Slack-to-GitHub identities. Keep the Ambiguous agent credential in the project-local `.ambi/config.json` (ignored). Configure the Trigger task runtime secret store separately from the local shell. Register Auth0 callback/logout URLs and the CopilotKit project only when those optional features are enabled.

### Pre-flight order

1. Confirm Node.js 24, npm, one lockfile and the ignored environment path.
2. Validate core variable presence without printing values.
3. Verify Neon connectivity and rollback, then import only validated pilot IDs.
4. Verify Trigger CLI/project access and run the data-free probe.
5. Verify Talacha Slack signature, app identity, permitted channel and complete thread pagination.
6. Verify GitHub App installation and read permissions; do not create an issue or comment during pre-flight.
7. Verify one bounded `openai/gpt-5.6-luna` structured response through OpenRouter.
8. Run focused authorization, tenant-isolation, transaction and recovery checks before enabling autonomous execution.
9. Enable optional Auth0/CopilotKit, Exa, Ambiguous or Mozilla.ai work only after the core gate and each feature's acceptance evidence exists.

The readiness result belongs in `tasks.md` with `PASS`, `PARTIAL`, `FAIL` or `NOT RUN` for each check. A populated `.env`, successful CLI login, package installation or local mock is not integration evidence by itself.

## Complete variable reference

| Exact input name | Meaning / destination |
|---|---|
| `APP_BASE_URL` | Canonical HTTPS URL; Vercel and Trigger |
| `SIGNAL_DASHBOARD_TENANT_ID` | Explicit server-only tenant context for the MVP dashboard; never expose or accept from the browser |
| `DATABASE_URL` | Pooled runtime Neon connection; Vercel and Trigger |
| `DATABASE_URL_UNPOOLED` | Migration connection; authorized local/CI migration environment only |
| `TRIGGER_PROJECT_REF` | Existing Trigger project reference; build/deploy configuration |
| `TRIGGER_SECRET_KEY` | Environment-specific task/API credential; Vercel and Trigger recovery access |
| `TRIGGER_ACCESS_TOKEN` | Optional noninteractive CLI deployment credential; local deployment environment or CI only, not web/task runtime |
| `SLACK_SIGNING_SECRET` | Request verification; Vercel only |
| `SLACK_BOT_TOKEN` | Installed workspace bot; Vercel modal calls and Trigger reads/notifications |
| `SLACK_THREAD_READ_TOKEN` | Optional separately authorized thread-reader token; Trigger only; no automatic fallback |
| `GITHUB_WEBHOOK_SECRET` | Raw-body verification for the selected repository webhook; Vercel only |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Mint short-lived installation tokens; Trigger only |
| `OPENROUTER_API_KEY` | Single model provider credential; Trigger only |
| `OPENROUTER_MODEL` | Exactly `openai/gpt-5.6-luna` initially; no silent model fallback |
| `CRON_SECRET` | Protected recovery/cleanup endpoint bearer; Vercel and authorized operator |
| `SIGNAL_PILOT_CONFIG_PATH` | Local bootstrap JSON path; import validated configuration into PostgreSQL, never expose client-side |
| `ENABLE_INSPECTOR`, `ENABLE_EXA`, `ENABLE_AMBIGUOUS` | Default `false`; independently validated flags |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` | Optional inspector Auth0 inputs; Vercel only, with `APP_BASE_URL` |
| `EXA_API_KEY`, `AMBIGUOUS_API_KEY` | Optional verified adapters; Trigger only |

Pilot JSON contains `tenantId`, `slackTeamId`, `workspaceTimezone`, `channels:[{channelId,githubInstallationId,githubRepoId,githubOwner,githubRepo,approverSlackIds}]`, `identities:[{slackUserId,githubLogin}]`, and optional `auth0Subjects:[{issuer,subject}]`. Credential fields store secret references only. Validate unique mappings, non-empty approvers and provider IDs during import; re-import increments configuration version. Disabled/deleted configuration fails closed for queued jobs.

Optional CopilotKit inference uses the same server-side OpenRouter adapter/model with its own bounded request budget; if hosted on Vercel, explicitly add `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` there. Auth0 uses `Auth0Client`, SDK-owned `/auth/*` routes and registered `/auth/callback`; verify the pinned SDK against the [official Next.js guide](https://auth0.com/docs/quickstart/webapp/nextjs). Never make a secret `NEXT_PUBLIC_*`. Optional providers' exact account configuration must be established during their timebox; a placeholder token does not enable a feature.

## I-01 — Bootstrap and access checks

These checks require provider access, not the application behavior implemented by I-02 through I-06. They share one 30-minute preflight budget; individual provider timeboxes do not extend it.

1. Connect existing authorized Vercel, Neon and Trigger projects to the intended environment, or complete authorized provisioning. Separate preview/development credentials from the pilot. The [Neon Vercel integration](https://neon.tech/docs/guides/vercel-native-integration) can supply Vercel variables; explicitly configure the matching runtime database connection on Trigger. Verify a database connection and a harmless transaction/rollback without application tables. Validate environment variable presence without printing values.
2. Configure Slack Events API request URL `https://www.sgn.lol/api/slack/events` and subscribe only to the approved non-shared channel message events plus `app_mention` for the explicit action path. Verify the signing secret and installation scopes, then prove signed observer delivery and full `conversations.replies` pagination in a permitted test channel. Bot capabilities include `app_mentions:read`, `chat:write`, channel metadata/history for allowed channel types, and user metadata if fetched. Token-type and rate-tier limitations may prevent thread reads even when mentions work. If unsupported, post that access blocker once and explicitly authorize/configure an eligible reader token; never silently borrow user credentials. Respect `Retry-After`. See [Slack replies API](https://docs.slack.dev/reference/methods/conversations.replies/).
3. Configure the GitHub `rmontero/signal` webhook URL `https://www.sgn.lol/api/github/webhooks` with JSON content type, a unique `GITHUB_WEBHOOK_SECRET`, and Pull requests events. Verify the GitHub App is installed only on the selected repository with Issues write, Pull requests read and required metadata read. Inspect granted permissions, installation/repository numeric IDs, issue reads and assignee eligibility. Do not send a test issue/comment before the application approval path exists. Request no code-write, administration or deployment permission.
4. Verify Trigger CLI deployment authorization separately from task API access: use an existing CLI login or complete the authorized login handshake; CI uses `TRIGGER_ACCESS_TOKEN`. Pin compatible CLI/SDK versions and select the intended environment explicitly; the deploy default is production. An env file loaded by the CLI does not configure task-runtime secrets. See the official [login](https://trigger.dev/docs/cli-login-commands) and [deploy](https://trigger.dev/docs/cli-deploy-commands) guides. Deploy and invoke the temporary `signal.preflight` connectivity probe: empty input, constant status output, no workplace data, no GitHub writes, and no claim to exercise the outbox. Separately obtain one bounded schema-valid response from the selected OpenAI model through OpenRouter using synthetic text. Record these as access checks, not business-flow acceptance.

## Application acceptance — after implementation

| Task | Required evidence |
|---|---|
| I-02 | Apply reviewed Drizzle migrations sequentially; import validated pilot mappings; prove commit/rollback, uniqueness and cross-tenant FK rejection against the real isolated database |
| I-03 | Configure Event Subscriptions at `/api/slack/events` for `app_mention` and interactivity at `/api/slack/interactions`; prove signed durable ingress, acknowledgement timing and ID-only analysis dispatch |
| I-05 | Prove real Slack-approved issue creation and progress comments on the authorized demo target; verify returned identities and actual assignees |
| I-06 | Deploy compatible web and task contracts, configure `signal.recover` and `signal.cleanup`, prove persisted-job recovery and replay safety; remove the temporary preflight probe |
| V-01 / V-02 | Repeat required deployed acceptance, complete the verification matrix, and record demo and partner evidence |

During I-01 these application checks are **NOT RUN — pending implementation**, not external blockers. Missing credentials or inaccessible services are genuine access blockers; missing code is a ready implementation task. Core application readiness requires valid configuration, a migrated database, and the later acceptance evidence. Missing optional configuration leaves its routes disabled. Capture commands, timestamps, IDs and PASS/FAIL/PARTIAL/NOT RUN in the ledger; redact secrets and source content. Neither Vercel nor Trigger deployment proves the other occurred.
