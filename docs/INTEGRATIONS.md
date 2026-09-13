# Signal integrations

This matrix defines integration roles and acceptance, not live connection status.
Current dated evidence and blockers are maintained only in [tasks.md](../tasks.md).
OpenAI is the selected model provider, reached through the
single OpenRouter route. Trigger.dev is the core task engine. Vercel hosts the
Next.js web surface. Auth0, CopilotKit, Exa, Ambiguous AI, and Mozilla.ai are
optional and must not delay or weaken the Slack-to-GitHub path. A successful package install or CLI
login is not integration evidence; only the acceptance check in this document
counts.

| Tool | Useful role | Admission and timebox | Evidence needed |
|---|---|---|---|
| Slack | Passive channel observation; explicit review/approval surface | Core setup within I-01 budget | Signed mapped receipt, full permitted reads, then separately approved card/modal/result flow |
| GitHub App | Passive PR observation; selected issue/comment actions | Core setup within I-01 budget | Installation-bound webhook and PR reads; separate Issues write grant and real approved actions |
| OpenAI | Selected model capability: `gpt-5.6-luna` | Core through OpenRouter; 15 minutes | Bounded schema-valid response through the configured route |
| OpenRouter | One inference route to `openai/gpt-5.6-luna` | Core preflight; 15 minutes | Actual provider response; a key or mock does not establish access |
| Trigger.dev | Durable background analysis and dispatch tasks | Core preflight; 15 minutes | Correct deployed environment/version, completed task, persisted result and replay safety |
| Vercel | Host the Next.js App Router web surface | Core deployment preflight; 15 minutes | Intended deployment, health and signed ingress/task-dispatch evidence separately |
| Auth0 | Optional login for a tenant-scoped proposal inspector | 15 minutes, then defer | Implemented session/mapping path, real login and unmapped-subject denial |
| CopilotKit | Explain one selected persisted proposal and evidence | 15 minutes after Auth0, then defer | Implemented route and tenant-authorized explanation |
| Exa | Search approved, sanitized public documentation | 15 minutes after core, then defer | Persisted initiating-actor consent and actual cited public results |
| Ambiguous AI | Read-only allowlisted runbook context in a demo workspace | 15 minutes, saved time only | Verified permitted dataset retrieval; CLI login does not count |
| Mozilla.ai | Offline evaluation of synthetic analysis output | 15 minutes, saved time only | Actual use of the optional tool on synthetic fixtures; ordinary app tests do not count |

## Core services

Start with [passive setup](INFRASTRUCTURE.md#passive-observation-setup). Slack's
Events API URL is `https://www.sgn.lol/api/slack/events`; the GitHub **App** webhook
URL is `https://www.sgn.lol/api/github/webhooks`. Public channel observation uses
`message.channels`/`channels:history`; approved private channels additionally use
`message.groups`/`groups:history`. If using `conversations.info` for channel
verification, add `channels:read` or `groups:read` for those channel types;
current Trigger tasks use the replies reader directly. Invite the bot to the mapped
channels. GitHub observation needs Pull requests read and Metadata read on the
selected repository. The current classifier requires the installation ID supplied
by App deliveries. These permissions and event types follow [Slack public events](https://docs.slack.dev/reference/events/message.channels/),
[private events](https://docs.slack.dev/reference/events/message.groups),
[channel metadata](https://docs.slack.dev/reference/methods/conversations.info/)
and [GitHub PR webhooks](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request).

Passive receipt stores coordinates/hash and dispatches `signal.observe-event`;
background reads/classification can use OpenRouter but cannot create proposals,
Slack posts or GitHub writes. Establish [real server mappings](INFRASTRUCTURE.md#server-pilot-mapping)
and separate receipt evidence from processed classification evidence. Neither
preflight mode validates these mappings or runs provider checks.

For the separate [approved action stage](INFRASTRUCTURE.md#approved-action-setup),
add `app_mention`/`app_mentions:read`, `chat:write`, Slack interactivity at
`https://www.sgn.lol/api/slack/interactions`, and GitHub Issues write. These match
[Slack mentions](https://docs.slack.dev/reference/events/app_mention/),
[posting](https://docs.slack.dev/reference/methods/chat.postMessage/),
[interactivity](https://docs.slack.dev/interactivity/handling-user-interaction/),
[issue creation](https://docs.github.com/en/rest/issues/issues#create-an-issue)
and [progress comments](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).
Named approvers and immutable payload review remain mandatory for each action.
No GitHub code-write, admin or deployment permissions are required.

OpenAI supplies the selected model capability, but Signal does not call the
OpenAI API directly. Configure `OPENROUTER_MODEL` as exactly
`openai/gpt-5.6-luna`; the only provider credential is `OPENROUTER_API_KEY`.
The model is therefore technically used through OpenRouter, and any prize or
sponsor eligibility claim about OpenAI usage must be checked separately.

OpenRouter is the sole model route. Configure `OPENROUTER_API_KEY`,
`OPENROUTER_MODEL`, a 30-second request timeout, and the documented application
limits of at most two model requests per analysis. Each request is limited to
12,000 input tokens and 2,000 output tokens (including provider-counted
reasoning). The adapter sends strict JSON schema `response_format` with
`provider.require_parameters: true`, restricting routing to endpoints that support
the requested parameters. Routing errors fail the call; the adapter does not
retry with relaxed parameters or another model. See [structured-output routing](https://openrouter.ai/docs/guides/features/structured-outputs).
Synthetic request/error tests verify this client behavior; a historical
model listing or a configured model name does not prove current account access
or structured-output behavior; acceptance must exercise the selected route.

Acceptance is one real, bounded extraction request using sanitized fixture
text, returning schema-valid output through OpenRouter, with provider request
ID, duration, and status recorded without source text, prompt, or secret.
Direct OpenAI API calls and a second inference route are out of scope.

Trigger.dev is the only background task engine. Configure a Trigger project,
the deployment environment, server-side access key, and these frozen task
identifiers: `signal.observe-event`, `signal.analyze-thread`, `signal.execute-operation`,
`signal.reconcile-operation`, `signal.notify-slack`, `signal.recover`, and
`signal.cleanup`. `signal.search-public-docs` is the planned optional Exa task,
not a currently exported task.
Configure `TRIGGER_PROJECT_REF` and `TRIGGER_SECRET_KEY`, the web runtime's
enqueue access, and the task runtime's secret store. Business task arguments
contain only `{ tenantId, jobId, schemaVersion: 1 }`; the worker loads the
outbox job by both IDs and verifies ownership. Scheduled tasks receive platform
schedule metadata only, enumerate tenant IDs, and then invoke the same scoped
services. The database operation guard remains authoritative. Add
Trigger task-level idempotency keys as a second protection for
delivery/re-execution. Idempotency does not make an external POST safe by
itself; uncertain GitHub writes still enter `UNKNOWN` and reconcile a stable
marker through read-only reconciliation. A zero-match or absent marker never permits
another GitHub POST; only a verified marker match can settle success.
Operation states are `READY`, `SENDING`,
`SUCCEEDED`, `FAILED`, `UNKNOWN`, and `STALE`.

The historical temporary `signal.preflight` probe in CONTRACTS is not currently
exported in `src/trigger/tasks.ts`; a local worker-ready message does not prove
a probe or deployed task ran. Business-flow acceptance follows I-03 and I-06;
it is not a prerequisite for local implementation. Acceptance is a real task enqueue, completion, and replay with the same key,
showing one persisted logical operation and recovery state. A local queue or
mock is useful development evidence but is not a live integration result.

Vercel hosts the single Next.js repository. Its server receives/verifies events,
persists them and enqueues tasks; Trigger has its own deployed worker and secret
store. Follow the [variable/runtime reference](INFRASTRUCTURE.md#complete-variable-reference):
webhook signing secrets belong on Vercel, provider read/model credentials belong
on Trigger, and migration/import/CLI credentials belong in the operator's
environment. Match the intended database, task environment and deployed contracts.
`TRIGGER_PROJECT_REF` is an operator consistency check; the current Trigger config
pins its project directly. Vercel env presence and dashboard configuration
indicators cannot prove Trigger credentials or provider connectivity.

Acceptance is the intended preview/pilot deployment that boots, reaches `GET /healthz`, and
can enqueue a bounded task against the configured environment. Record the
deployment URL, run/delivery IDs, status and counts only. A health response alone
is process liveness, not database or provider health. Local preflight performs no
deployments, imports, messages, model calls or other external operations.

## Optional integrations

These are contracts for optional implementations. Configuration alone does not
create routes, sessions or consent flows. In particular, the pilot importer does
not persist `auth0Subjects`; see [mapping limitations](INFRASTRUCTURE.md#server-pilot-mapping).

Auth0 is a read-only inspector login. Configure an Auth0 application using the
current Next.js Auth0Client approach, its domain, client ID, client secret,
callback/logout URLs, and a server-side session secret. Add an explicit,
persisted Auth0 subject-to-tenant mapping; an authenticated subject without a
mapping is denied. Auth0 never approves GitHub work and never supplies Slack
approval authority. Acceptance is a real login followed by viewing a proposal
belonging to the mapped tenant, plus denial for an unmapped subject.

CopilotKit may explain one selected persisted proposal after Auth0 succeeds.
Configure its UI/server endpoint and model access through the existing
OpenRouter adapter. The server loads the authorized proposal, exact payload
hash, and evidence; the assistant receives read-only context and no tools that
approve, dispatch, edit, or write to GitHub. The frozen optional routes are
`/api/proposals` and `/api/copilotkit`; Auth0 owns the `/auth/*` login routes.
The human-in-the-loop UI is not a backend authority surface. Acceptance is a
tenant-filtered explanation whose facts match the persisted proposal, with no
mutation request available.

Exa is an explicitly approved public-document search. Configure an Exa API key
and the available `exa/exa-search-api` integration. Before transmission,
display and approve the exact sanitized query; keep private workplace text,
credentials, Slack content, and GitHub payloads out of it. Limit the result to
three public references and treat timeout/rate-limit as a disabled optional
feature. Acceptance is one real approved query returning cited public links;
the approval is independent of GitHub approval.

Ambiguous AI is a read-only runbook source in a dedicated demo workspace.
Configure a Bearer token with access restricted to that workspace and confirm
the permitted dataset and API schema first. The verified API observation is
`GET https://app.ambiguous.ai/api/documents`; pagination and filtering
parameters are not assumed. This is a planning observation, not a live check in
this revision. Do not use mail, chat, calendar, task, or other
write capabilities. If per-document selection or schema cannot be confirmed,
defer. Acceptance is one real retrieval of an allowlisted synthetic/demo
runbook, cited in a proposal, with no outbound write.

Mozilla.ai is offline evaluation tooling, not a production service. Configure
the evaluator locally with sanitized synthetic fixtures and an evaluation
question/context pair. The documented shape uses `LlmJudge.run(context,
question)`. Acceptance is a saved result covering grounded extraction and
failure boundaries; no private data export, runtime migration, or production
Python dependency is allowed.

## Timebox, evidence, and deferral

Run core preflight before optional work. Each optional attempt has 15 minutes
and at most two repair attempts. At four hours, feature work freezes; optional
tools never consume the protected two finishing hours. If setup exceeds its
slot, credentials are unavailable, or the acceptance check cannot be run,
mark the integration `NOT RUN` or `PARTIAL`, record the concrete prerequisite,
and disable it so boot, build, core tasks, and tests remain unaffected. There
are no mandatory sponsors or partner counts. The six-hour plan is four hours
of implementation plus two protected hours for verification, polish, demo, and
documentation.

`npm run preflight` checks only currently supplied names; absent future providers
do not stop local development. `npm run preflight -- --strict` explicitly checks
the full release configuration list, but even a complete result leaves live
acceptance **NOT RUN**. Use commands, timestamps, IDs and bounded statuses in
`tasks.md` to distinguish local tests, configuration, deployment and actual
integration evidence. This document does not supersede or refresh that ledger.

Planning references: [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
[Trigger.dev idempotency](https://trigger.dev/docs/idempotency),
[Auth0 Next.js quickstart](https://auth0.com/docs/quickstart/webapp/nextjs),
[CopilotKit human-in-the-loop guidance](https://docs.copilotkit.ai/agent-spec/human-in-the-loop),
[Mozilla.ai evaluation](https://mozilla-ai.github.io/any-agent/evaluation/), and
[Ambiguous AI agents API](https://www.ambiguous.ai/agents/api). The OpenRouter
model and parameter observation came from its public `/api/v1/models` response;
the Auth0 and Exa marketplace slugs were observed as `auth0/client` and
`exa/exa-search-api` respectively.
