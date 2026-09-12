# Signal integrations

This matrix records the eight requested tools plus Vercel as a supporting
hosting platform. OpenAI is the selected model provider, reached through the
single OpenRouter route. Trigger.dev is the core task engine. Vercel hosts the
Next.js web surface. Auth0, CopilotKit, Exa, Ambiguous AI, and Mozilla.ai are
optional and must not delay or weaken the Slack-to-GitHub path. A successful package install or CLI
login is not integration evidence; only the acceptance check in this document
counts.

| Tool | Useful role | Admission and timebox | Initial status |
|---|---|---|---|
| OpenAI | Selected model capability: `gpt-5.6-luna` | Core preflight through OpenRouter; 15 minutes | PARTIAL — adapter is wired; live request NOT RUN |
| OpenRouter | One inference route to `openai/gpt-5.6-luna` | Core preflight; 15 minutes | PARTIAL — strict adapter/tests PASS; live request NOT RUN |
| Trigger.dev | Durable background analysis and dispatch tasks | Core preflight; 15 minutes | PARTIAL — tasks build/readiness PASS; production task run NOT RUN |
| Vercel | Host the Next.js App Router web surface | Core deployment preflight; 15 minutes | PASS — production deployment READY; provider runtime gate pending |
| Auth0 | Optional login for a tenant-scoped proposal inspector | 15 minutes, then defer | DEFERRED — no valid app/session configuration |
| CopilotKit | Explain one selected persisted proposal and evidence | 15 minutes after Auth0, then defer | DEFERRED — no tenant-authorized inspector route |
| Exa | Search approved, sanitized public documentation | 15 minutes after core, then defer | DEFERRED — no real key/consent path |
| Ambiguous AI | Read-only allowlisted runbook context in a demo workspace | 15 minutes, saved time only | DEFERRED — no verified dataset retrieval |
| Mozilla.ai | Offline evaluation of synthetic analysis output | 15 minutes, saved time only | DEFERRED — evaluation not run |

## Core services

OpenAI supplies the selected model capability, but Signal does not call the
OpenAI API directly. Configure `OPENROUTER_MODEL` as exactly
`openai/gpt-5.6-luna`; the only provider credential is `OPENROUTER_API_KEY`.
The model is therefore technically used through OpenRouter, and any prize or
sponsor eligibility claim about OpenAI usage must be checked separately.

OpenRouter is the sole model route. Configure `OPENROUTER_API_KEY`,
`OPENROUTER_MODEL`, a 30-second request timeout, and the documented application
limits of at most two model requests per analysis. Each request is limited to
12,000 input tokens and 2,000 output tokens (including provider-counted
reasoning). The adapter must request structured output with
`response_format`; set the provider routing option `require_parameters: true`
so a route that does not honor the required parameters is rejected. The public
models response observed during planning lists this model and supports both
`response_format` and `structured_outputs`.

Acceptance is one real, bounded extraction request using sanitized fixture
text, returning schema-valid output through OpenRouter, with provider request
ID, duration, and status recorded without source text, prompt, or secret.
Direct OpenAI API calls and a second inference route are out of scope.

Trigger.dev is the only background task engine. Configure a Trigger project,
the deployment environment, server-side access key, and these frozen task
identifiers: `signal.analyze-thread`, `signal.execute-operation`,
`signal.reconcile-operation`, `signal.notify-slack`, `signal.recover`, and
`signal.cleanup`. The optional Exa task is `signal.search-public-docs`.
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

I-01 establishes access using the temporary, data-free `signal.preflight` probe
defined in CONTRACTS. Business-flow acceptance follows I-03 and I-06; it is
not a prerequisite for their implementation. Acceptance is a real task enqueue, completion, and replay with the same key,
showing one persisted logical operation and recovery state. A local queue or
mock is useful development evidence but is not a live integration result.

Vercel hosts the single Next.js repository. Configure a linked Vercel project,
the production/preview environment selection, Node.js 24, the deployment
branch, `APP_BASE_URL`, `DATABASE_URL`, `TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY`,
`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, and `CRON_SECRET`, plus optional
inspector variables when enabled. Keep all server-only secrets required by the
web and Trigger runtimes out of browser configuration.
Keep browser-exposed configuration limited to non-secret public values. The
observed `vercel whoami` login proves CLI account access only; it does not prove
a linked Signal project, deployment, or service integration.

Acceptance is a preview deployment that boots, reaches the health surface, and
can enqueue a bounded task against the configured environment. Record the
deployment URL and status only. Do not upgrade the CLI or deploy during this
documentation task.

## Optional integrations

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
parameters are not assumed. Do not use mail, chat, calendar, task, or other
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

Current evidence is limited to the OpenRouter model/parameter observation and
Vercel CLI login described above. No real service integration, live task,
deployment, optional login, search, Ambiguous retrieval, or Mozilla evaluation
has been demonstrated yet.

Planning references: [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
[Trigger.dev idempotency](https://trigger.dev/docs/idempotency),
[Auth0 Next.js quickstart](https://auth0.com/docs/quickstart/webapp/nextjs),
[CopilotKit human-in-the-loop guidance](https://docs.copilotkit.ai/agent-spec/human-in-the-loop),
[Mozilla.ai evaluation](https://mozilla-ai.github.io/any-agent/evaluation/), and
[Ambiguous AI agents API](https://www.ambiguous.ai/agents/api). The OpenRouter
model and parameter observation came from its public `/api/v1/models` response;
the Auth0 and Exa marketplace slugs were observed as `auth0/client` and
`exa/exa-search-api` respectively.
