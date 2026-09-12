# Signal infrastructure and preflight

This is a setup specification. No account, secret, installation, deployment or live smoke test is established by these documents. Work begins through I-01 in [tasks.md](../tasks.md); use the existing authorization boundaries before provisioning or spending.

## Inputs and configuration

Pin compatible versions at bootstrap: Node.js 24, Next.js, React, TypeScript, Drizzle, Neon driver, Trigger SDK/CLI, schema validator and provider clients. Keep one `package-lock.json`. Choose a Neon connection mode supporting interactive transactions and row locks; verify those behaviors against a real database, not an HTTP batch substitute.

| Exact input name | Meaning / destination |
|---|---|
| `APP_BASE_URL` | Canonical HTTPS URL; Vercel and Trigger |
| `DATABASE_URL` | Pooled runtime Neon connection; Vercel and Trigger |
| `DATABASE_URL_UNPOOLED` | Migration connection; authorized local/CI migration environment only |
| `TRIGGER_PROJECT_REF` | Existing Trigger project reference; build/deploy configuration |
| `TRIGGER_SECRET_KEY` | Environment-specific task/API credential; Vercel and Trigger recovery access |
| `TRIGGER_ACCESS_TOKEN` | Optional noninteractive CLI deployment credential; local deployment environment or CI only, not web/task runtime |
| `SLACK_SIGNING_SECRET` | Request verification; Vercel only |
| `SLACK_BOT_TOKEN` | Installed workspace bot; Vercel modal calls and Trigger reads/notifications |
| `SLACK_THREAD_READ_TOKEN` | Optional separately authorized thread-reader token; Trigger only; no automatic fallback |
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
2. Verify Slack installation scopes and full `conversations.replies` pagination in a permitted, non-shared test channel. Bot capabilities include `app_mentions:read`, `chat:write`, channel metadata/history for allowed channel types, and user metadata if fetched. Token-type and rate-tier limitations may prevent thread reads even when mentions work. If unsupported, post that access blocker once and explicitly authorize/configure an eligible reader token; never silently borrow user credentials. Respect `Retry-After`. See [Slack replies API](https://docs.slack.dev/reference/methods/conversations.replies/).
3. Verify the GitHub App is installed only on selected repositories with Issues write, Pull requests read and required metadata read. Inspect granted permissions, installation/repository numeric IDs, issue reads and assignee eligibility. Do not send a test issue/comment before the application approval path exists. Request no code-write, administration or deployment permission.
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
