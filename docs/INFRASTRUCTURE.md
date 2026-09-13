# Signal infrastructure and preflight

This is a setup specification checked against repository source. Configuration does not establish account access, installation, deployment or a live integration. Current evidence and blockers belong in [tasks.md](../tasks.md). Local implementation can proceed while provider setup is incomplete; provider operations follow the task's existing authorization.

## Inputs and configuration

Pin compatible versions at bootstrap: Node.js 24, Next.js, React, TypeScript, Drizzle, Neon driver, Trigger SDK/CLI, schema validator and provider clients. Keep one `package-lock.json`. Choose a Neon connection mode supporting interactive transactions and row locks; verify those behaviors against a real database, not an HTTP batch substitute.

## Autonomous-agent pre-flight

`npm run preflight` checks only recognized configuration names currently supplied in the environment. It loads ignored `.env`, then `.env.local`; later file assignments override earlier ones and the parent shell takes precedence. It does not use Next.js's full `.env.development*`/`.env.production*` loading sequence. Never print these files or use secrets in command arguments, prompts, commits or `NEXT_PUBLIC_*` variables. Keep development, preview and production configuration separate.

Default scope is dynamic, not the earlier fixed four-variable bootstrap list. An absent core name is deferred. A supplied core name that is empty, whitespace-only, a literal unset marker, or a recognized template placeholder fails with its name only. Optional missing/placeholder values never block core development. Zero supplied core names is a valid local check with an explicit warning that readiness is unproven. The script makes no network calls and reads no pilot file or database.

### Explicit strict release configuration gate

Run `npm run preflight -- --strict`, or explicitly set `SIGNAL_PREFLIGHT_STRICT=1`, to check all 16 core names below. This is an operator checklist covering web, task and local setup inputs, not a requirement to put every name in each runtime. Exit zero means non-empty values without recognized placeholders; it does not validate credentials, URLs, model availability, permissions, JSON contents, imported mappings, optional flags, or live behavior. Unknown placeholder formats may still pass. Strict configuration must be followed by the live acceptance checks before a release claim.

| Setting | Required state and verification |
|---|---|
| `APP_BASE_URL` | Intended canonical HTTPS callback origin; currently an operator/optional-inspector input, not used to register provider URLs automatically |
| `SIGNAL_DASHBOARD_TENANT_ID` | Server-only MVP dashboard tenant context; must be an active tenant ID and is never accepted from browser input |
| `DATABASE_URL` | Pooled Neon runtime connection; verify a harmless query and tenant-scoped transaction |
| `DATABASE_URL_UNPOOLED` | Direct Neon migration connection; verify migrations can run separately from pooled access |
| `TRIGGER_PROJECT_REF` | Must agree with project `proj_cehggonaqopuuhibihif` in `trigger.config.ts`; the config currently pins the project directly, so this env name does not select it |
| `TRIGGER_SECRET_KEY` | Task/API secret for the selected Trigger environment; verify authentication without printing it |
| `SLACK_SIGNING_SECRET` | Talacha.dev Slack app signing secret; verify raw-body signature rejection and acceptance |
| `SLACK_BOT_TOKEN` | Talacha.dev installation token with only the documented app scopes; verify identity and permitted channel metadata |
| `GITHUB_WEBHOOK_SECRET` | GitHub App webhook HMAC secret, matched to the registered callback; Vercel verifies `X-Hub-Signature-256` |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_LOGIN` | App identity, private key and actual bot author login; read access for observation, separately approved Issues write for actions, expected author for reconciliation |
| `OPENROUTER_API_KEY` | OpenRouter credential; verify one bounded structured response using the exact model below |
| `OPENROUTER_MODEL` | Exactly `openai/gpt-5.6-luna`; reject silent fallback or a direct OpenAI route |
| `CRON_SECRET` | High-entropy secret for the protected maintenance endpoint; verify missing/wrong bearer is rejected |
| `SIGNAL_PILOT_CONFIG_PATH` | Path to a validated local mapping file; verify tenant, Talacha workspace/channel, repository, approver and identity IDs before import |

The complete live gate adds real database transaction/rollback evidence, imported pilot mappings, deployed task execution, permitted full Slack reads, GitHub installation/permission reads, and a schema-valid OpenRouter response. The approved write flow then needs its own create/comment/replay and recovery evidence. None of these are executed by either preflight mode.

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
| `SLACK_THREAD_READ_TOKEN` | Reserved configuration; current `src/trigger/tasks.ts` does not read it. Setting it does not fix a bot read failure. Separate reader wiring needs implementation/review and explicit authorization. |
| `TRIGGER_ACCESS_TOKEN` | Noninteractive CLI/CI deployment credential only; never load into application tasks. |

Mozilla.ai has no environment credential in this design. Its optional evaluator runs offline against synthetic fixtures and must not receive Slack text, credentials, private URLs or production traces. Runtime inference uses the existing OpenRouter adapter; do not add `OPENAI_API_KEY` or a second inference gateway.

### Non-env setup that is still mandatory

Use the [server pilot mapping](#server-pilot-mapping) procedure below; the app reads PostgreSQL mappings, not the local JSON. Configure the Trigger task secret store separately from Vercel and the local shell. Register Auth0 callbacks and CopilotKit only after their optional implementations exist; neither supplies Slack approval authority.

### Pre-flight order

1. Confirm Node.js 24, npm, one lockfile and the ignored environment path.
2. Run current-scope configuration checks and focused synthetic tests; proceed with local work.
3. For an authorized live setup, verify Neon transaction/rollback and import only validated pilot IDs into the intended database.
4. Configure the separate web/task environments and verify deployment/run access. A local worker being ready is not a deployed run.
5. Prove signed Slack/GitHub observer receipt, durable storage and dispatch, then separately prove permitted source reads and classification.
6. For the action stage, run strict configuration checks, verify the additional scopes and full Slack reads, and record one bounded structured OpenRouter response using synthetic text.
7. Complete authorization, tenant, transaction, recovery, actual approved create/comment and replay acceptance before claiming release readiness.
8. Enable optional integrations only after their implementation and separate acceptance evidence exist.

The readiness result belongs in `tasks.md` with `PASS`, `PARTIAL`, `FAIL` or `NOT RUN` for each check. A populated `.env`, successful CLI login, package installation or local mock is not integration evidence by itself.

## Complete variable reference

| Exact input name | Meaning / destination |
|---|---|
| `APP_BASE_URL` | Operator's canonical HTTPS origin; optional inspector on Vercel if implemented; no current core task consumer |
| `SIGNAL_DASHBOARD_TENANT_ID` | Explicit server-only tenant context for the MVP dashboard; never expose or accept from the browser |
| `DATABASE_URL` | Pooled runtime Neon connection; Vercel and Trigger |
| `DATABASE_URL_UNPOOLED` | Migration connection; authorized local/CI migration environment only |
| `TRIGGER_PROJECT_REF` | Operator/project metadata; match the project pinned in `trigger.config.ts` |
| `TRIGGER_SECRET_KEY` | Correct Trigger environment's enqueue/read credential on Vercel; task SDK/recovery access in Trigger must target that same environment |
| `TRIGGER_ACCESS_TOKEN` | Optional noninteractive CLI deployment credential; local deployment environment or CI only, not web/task runtime |
| `SLACK_SIGNING_SECRET` | Request verification; Vercel only |
| `SLACK_BOT_TOKEN` | Installed workspace bot; Vercel modal calls and Trigger reads/notifications |
| `SLACK_THREAD_READ_TOKEN` | Reserved for separately authorized reader wiring; not consumed by current tasks |
| `GITHUB_WEBHOOK_SECRET` | Raw-body verification for the GitHub App webhook; Vercel only |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_LOGIN` | Mint short-lived installation tokens and verify the expected bot author; Trigger only |
| `OPENROUTER_API_KEY` | Single model provider credential; Trigger only |
| `OPENROUTER_MODEL` | Exactly `openai/gpt-5.6-luna` initially; no silent model fallback |
| `CRON_SECRET` | Protected recovery/cleanup endpoint bearer; Vercel and authorized operator |
| `SIGNAL_PILOT_CONFIG_PATH` | Local bootstrap JSON path; import validated configuration into PostgreSQL, never expose client-side |
| `ENABLE_INSPECTOR`, `ENABLE_EXA`, `ENABLE_AMBIGUOUS` | Default `false`; independently validated flags |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` | Optional inspector Auth0 inputs; Vercel only, with `APP_BASE_URL` |
| `CPK_INTELLIGENCE_API_KEY` | Optional managed CopilotKit project key; only its implemented server runtime, after tenant/retention checks |
| `EXA_API_KEY`, `AMBIGUOUS_API_KEY` | Optional verified adapters; Trigger only |

Vercel requires `DATABASE_URL`, the two webhook signing secrets, and `TRIGGER_SECRET_KEY` for receipt/storage/dispatch; `SIGNAL_DASHBOARD_TENANT_ID` selects the server dashboard and `CRON_SECRET` protects maintenance. Add `SLACK_BOT_TOKEN` there for action modals. Trigger source reads/classification require `DATABASE_URL`, `SLACK_BOT_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`; GitHub reconciliation also requires `GITHUB_APP_LOGIN`. Both runtimes must use the same intended database and compatible deployed contracts.

Keep `DATABASE_URL_UNPOOLED`, `SIGNAL_PILOT_CONFIG_PATH` and CLI `TRIGGER_ACCESS_TOKEN` in the authorized local/CI operator environment. They are not web/task runtime requirements. Vercel's Settings display only sees Vercel's environment; missing Trigger-only keys there does not prove Trigger is unconfigured, and a configured indicator does not prove connectivity. Do not copy task credentials to Vercel merely to change that display.

Vercel deployment and Trigger deployment are separate. Setting Vercel variables or loading a local env file does not populate deployed Trigger task secrets. Configure the intended Trigger environment explicitly and confirm its task version and enqueue credential match Vercel; see [Trigger environment variables](https://trigger.dev/docs/deploy-environment-variables) and [deployed-task authentication](https://trigger.dev/docs/deployment/overview). `trigger.config.ts` pins the project and Node 24 and currently has no automatic Vercel env synchronization. Do not overwrite platform-managed task credentials with another environment's key.

If implemented, optional CopilotKit inference must use the same server-side OpenRouter adapter/model with its own bounded request budget; a Vercel-hosted inspector would need the model variables there. Auth0's planned `Auth0Client`/`/auth/*` routes require implementation and callback registration; env presence does not establish those routes. See the [official Next.js guide](https://auth0.com/docs/quickstart/webapp/nextjs). Never make a secret `NEXT_PUBLIC_*`.

## Passive observation setup

These are operator setup instructions, not a record that registration or live delivery occurred. The intended production origin is `https://www.sgn.lol`; preview/development need their own deliberately selected callback origin and credentials.

| Provider surface | Exact callback and minimum configuration |
|---|---|
| Slack app → Event Subscriptions | Request URL `https://www.sgn.lol/api/slack/events`; signing secret in Vercel `SLACK_SIGNING_SECRET`; HTTP Events API |
| Public allowlisted Slack channels | Bot event `message.channels`, bot scope `channels:history`; invite the bot into only the intended channels |
| Private allowlisted Slack channels, if used | Add bot event `message.groups` and `groups:history`; explicitly invite the bot to each private channel |
| Slack channel metadata verification via API, if used | Add `channels:read` for public channels or `groups:read` for private channels only when using `conversations.info`; current Trigger tasks call the replies reader directly |
| GitHub App → General → Webhook | Active webhook URL `https://www.sgn.lol/api/github/webhooks`; secret equals Vercel `GITHUB_WEBHOOK_SECRET`; keep SSL verification enabled; App deliveries use JSON |
| GitHub App → Permissions & events | Repository Pull requests **Read-only**, Metadata **Read-only**; subscribe only to Pull request events for observation; install on only the selected repository, intended pilot `rmontero/signal` |

Slack's event/scopes reference documents [public messages](https://docs.slack.dev/reference/events/message.channels/), [private messages](https://docs.slack.dev/reference/events/message.groups) and [channel metadata](https://docs.slack.dev/reference/methods/conversations.info/). Reinstall/reauthorize when changing granted scopes. Passive receipt does not need `app_mentions:read` or `chat:write`. Do not subscribe to DM/MPIM events or request `users:read`, email, admin, channel-join or public-posting scopes for this path; current tasks do not fetch user profiles. Reject shared/Slack Connect sources and verify actual channel state before import.

The GitHub classifier requires `installation.id`, `repository.id`, an allowed PR action and a valid sender login. Configure an **App webhook**, not an additional repository Settings → Webhooks hook: GitHub supplies the installation field for events sent to an App. Current actions are `opened`, `synchronize`, `reopened`, `closed`, `ready_for_review`, and `converted_to_draft`; PR reviews/comments and `ping` are not observed PR acceptance. Pull requests read is sufficient for that subscription; Contents, Actions, administration and deployment permissions are unnecessary. See [GitHub webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request) and [minimum App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

Receipt persists coordinates/hash and an outbox job. `signal.observe-event` subsequently reads the permitted Slack thread or PR and may send content to OpenRouter for classification. This requires the matching Trigger credentials and model configuration, even with write scopes absent. Slack's current [replies API](https://docs.slack.dev/reference/methods/conversations.replies/) lists bot and user history scopes; verify the actual installed bot's channel access, complete pagination and rate tier. Current task wiring uses `SLACK_BOT_TOKEN`; a value in `SLACK_THREAD_READ_TOKEN` has no effect. A read failure blocks classification/full-thread acceptance and is not repaired by silently borrowing user credentials.

An authorized signed URL challenge proves only Slack callback verification. A persisted observed-event ID plus outbox job proves receipt; a completed task with persisted classification proves processing. Record those separately and verify duplicate delivery creates no second logical job. Passive processing must create no proposal, approval, Slack message or GitHub mutation. Unsigned 401, ignored 202, a GitHub ping, and `GET /healthz` 200 are not that evidence.

## Approved action setup

After observation and core checks, an authorized operator may add Slack bot event `app_mention`, scope `app_mentions:read`, and `chat:write` for cards/results. Enable Interactivity & Shortcuts with Request URL `https://www.sgn.lol/api/slack/interactions`, using the same signing secret. Keep existing channel read/history scopes and memberships. This route handles Review, Dismiss and the read-only modal submission; there is no slash command or web approval endpoint. Slack documents the [mention scope](https://docs.slack.dev/reference/events/app_mention/), [message permission](https://docs.slack.dev/reference/methods/chat.postMessage/) and [interaction callback](https://docs.slack.dev/interactivity/handling-user-interaction/).

Separately grant the selected GitHub App installation Issues **Read and write**, retaining Pull requests/Metadata read. Issues read is only needed earlier if deliberately testing issue retrieval. Issue and progress-comment POSTs require Issues write; see [create issue](https://docs.github.com/en/rest/issues/issues#create-an-issue) and [create comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment). Install/permission grants alone are not application authority: persist named Slack approvers, verify exact payload/version/hash/expiry, and use only `CREATE_ISSUE` or `ADD_PROGRESS_COMMENT`. Configure the actual App bot login for reconciliation. `UNKNOWN` stays blocked for read-back; an absent marker never permits a retry.

## Server pilot mapping

The authorized operator prepares ignored `config/pilot.local.json` using [the example shape](../config/pilot.example.json), verifies real provider IDs, then runs `npm run pilot:import` against the intended database. The env `SIGNAL_PILOT_CONFIG_PATH` takes precedence over an explicit CLI path. Preflight checks only that this variable is configured; it does not read, validate or import the file. Placeholder/diagnostic IDs must never be promoted to real pilot mappings.

| Input | Actual requirement |
|---|---|
| `tenantId`, `slackTeamId` | One active tenant bound to the exact signed Slack team ID; never derive it from browser input or a model |
| `channels[].channelId` | Real allowlisted, non-shared channel; one mapping per tenant/channel |
| `githubInstallationId`, `githubRepoId` | Verify each real numeric provider ID independently, serialized as a string; do not substitute the App ID for installation ID; match webhook and installation access |
| `githubOwner`, `githubRepo` | Exact current repository coordinates matching the IDs; names alone do not select a tenant |
| `approverSlackIds` | Verified named human Slack IDs; importer currently requires at least one per channel even for passive setup; their presence does not grant provider write permissions |
| `identities` | Explicit Slack ID → GitHub login mappings for assignment; use an empty array when unverified; missing identities remain unassigned |
| `workspaceTimezone` | Intended IANA timezone; current importer accepts it but does not persist/use it, so it does not enable relative-deadline resolution |
| `auth0Subjects` | Optional planned inspector mappings; current importer accepts them but does not persist them, so they do not establish login-to-tenant authorization |

[Pilot validation](../src/config/pilot.ts) checks shape and duplicate channels/approvers/identities; it does not contact providers to verify identities, timezone or access. [The importer](../scripts/import-pilot.ts) upserts tenant/mappings/approvers/identities transactionally, disables removed records and increments configuration version. It currently sets `shared=false` from the operator's verified input; it does not query Slack. No credential field is accepted by this JSON schema.

Runtime ingress resolves Slack through the active team/channel mapping, and GitHub through active repository **and installation** mappings to one tenant. Multiple tenants matching a GitHub source fail closed. Set server-only `SIGNAL_DASHBOARD_TENANT_ID` to the same active tenant to view data; this does not register sources or import mappings. Verify database state with IDs/counts/enabled flags only, then prove signed delivery. The existing diagnostic mapping is not evidence of a real Talacha/repository setup.

## I-01 — Bootstrap and access checks

These checks require provider access, not the application behavior implemented by I-02 through I-06. They share one 30-minute preflight budget; individual provider timeboxes do not extend it.

1. Use only existing authorized projects and the selected environment. Verify a harmless database transaction/rollback and real pilot mappings without logging credentials or content.
2. Follow passive Slack/GitHub setup above. Verify granted read permissions and source access separately from event receipt. An access check does not authorize a test message, issue or comment.
3. Verify Trigger CLI deployment access separately from task API/runtime access, using the pinned CLI/SDK. The temporary `signal.preflight` task is a historical bootstrap design and is not currently exported in `src/trigger/tasks.ts`; do not claim it can run or that a ready local worker proves it ran. Record actual deployed business-task evidence, or hand off a scoped probe implementation to the coordinator if needed.
4. Obtain one authorized, bounded schema-valid model response using synthetic text. Record provider request/run IDs, timestamps, duration and status; never capture source, prompt or payload content.

## Application acceptance — after implementation

| Task | Required evidence |
|---|---|
| I-02 | Apply reviewed Drizzle migrations sequentially; import validated pilot mappings; prove commit/rollback, uniqueness and cross-tenant FK rejection against the real isolated database |
| I-03 | Prove signed observer ingress and ID-only dispatch first; separately prove `app_mention`, full thread reads, interactivity and acknowledgment timing for actions |
| I-05 | Prove real Slack-approved issue creation and progress comments on the authorized demo target; verify returned identities and actual assignees |
| I-06 | Deploy compatible web and task contracts, configure `signal.recover` and `signal.cleanup`, prove persisted-job recovery and replay safety |
| V-01 / V-02 | Repeat required deployed acceptance, complete the verification matrix, and record demo and partner evidence |

Record application checks as **NOT RUN** until demonstrated, even if the code or configuration exists. Missing credentials block the affected live check, not independent local work. Release acceptance requires the intended database schema, mappings, compatible deployed runtimes and the evidence above. Capture commands, timestamps, IDs and PASS/FAIL/PARTIAL/NOT RUN in the ledger; redact secrets and source content. Neither Vercel nor Trigger deployment proves the other occurred.
