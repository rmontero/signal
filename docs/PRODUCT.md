# Signal product requirements

Authority: [north_star.md](../north_star.md). Delivery gates: [roadmap.md](../roadmap.md). Status: [tasks.md](../tasks.md). Historical input: [original brief](reference/original-brief.md).

## Audience and first release

An engineering team already coordinating in Slack and GitHub. The MVP is a manually configured pilot with one Slack workspace, allowlisted non-shared channels, and selected repositories. The long-term product is multi-tenant SaaS; onboarding and enterprise controls are not prerequisites for the demo.

## Required behavior

| ID | Requirement | Acceptance |
|---|---|---|
| MVP-01 | Respond only to an explicit `@Signal` mention | Unmentioned conversation and bot-generated messages do not start analysis |
| MVP-02 | Read the complete invoked thread and relevant channel/participant metadata within configured limits | Missing pages or overflow withhold the executable proposal and explain why |
| MVP-03 | Extract decisions, tasks, owners, blockers, and deadlines with evidence | Each asserted fact references retrieved source material; absent facts remain absent |
| MVP-04 | Retrieve relevant issues and PRs from the channel's configured repository | At most five candidates; valid links; no access to a model-selected repository |
| MVP-05 | Present a compact action card and exact-payload review modal | Destination, issue title/body or comment, assignee, uncertainty, source links and analysis time are visible |
| MVP-06 | Require a named Slack approver for every GitHub write | Invalid actor, wrong tenant/channel, expired/superseded proposal, or payload mismatch cannot approve |
| MVP-07 | Create an issue from the approved immutable draft | Result includes actual GitHub issue URL/ID and returned assignee; no model call after approval |
| MVP-08 | Add an approved progress comment to an existing issue | Existing issue fields remain untouched; comment URL and target verified |
| MVP-09 | Resolve identities explicitly | Unmapped/ambiguous people remain unassigned; no display-name or email guessing |
| MVP-10 | Deduplicate provider deliveries, approvals, and task execution | Replayed event/double click/duplicate task does not cause another GitHub mutation |
| MVP-11 | Recover dispatch gaps and uncertain writes | Persisted outbox survives process loss; ambiguous POST outcomes reconcile rather than repost |
| MVP-12 | Confirm results in the original Slack thread | GitHub success is persisted first; Slack-only failure never repeats the GitHub action |
| MVP-13 | Enforce tenant boundaries from day one | Tenant-scoped lookups, compound relationships and tests reject mixed-tenant references |
| MVP-14 | Bound model/retrieval cost and protect source data | Limits enforced in code; no raw source/prompt/secret tracing; documented cleanup |
| MVP-15 | Ship repeatable setup, operational recovery and truthful verification | Runbooks, setup inputs, demo script, tests and evidence matrix are maintained |

## Interaction rules

`@Signal` at a thread root analyzes that message as a one-message thread. Inside a thread it reads the root and replies. Ignore Signal's own messages and other bot messages as triggers.

- New thread + ordinary mention: propose `CREATE_ISSUE` and show retrieved related issues/PRs as evidence.
- `@Signal update #713` or one explicit issue URL in an update invocation: propose `ADD_PROGRESS_COMMENT` in the mapped repository after validating the issue identity. Repository references outside the configured mapping fail closed.
- Thread already linked to a created issue: a later ordinary mention with changed source content proposes a progress comment. Explicit `update #N` takes precedence only after target validation.
- Multiple explicit issue targets: request one target; do not guess. A PR is not an issue target for this MVP.
- Repeated identical source/action fingerprint: return the pending proposal or recorded result. A pending proposal with new source content supersedes its predecessor; a distinct approved update can create a later comment.
- No actionable content: post one concise explanation with no approval controls.
- Missing owner: draft unassigned. Missing deadline: omit it. Ambiguous date/time: display the original wording as unresolved; do not schedule anything.
- No relevant GitHub result: create draft with that fact stated. Multiple related results: display at most five; semantic similarity alone never selects an existing issue as a write destination.
- Repository missing or unavailable: withhold the proposal and name the missing configuration without disclosing secrets.

## Draft and approval semantics

The card offers Review and Dismiss. Review opens a read-only modal with the full proposed mutation; its submission is the approval. Users correct a draft by dismissing it, clarifying the source thread and invoking Signal again. There is no draft editor in the MVP.

Allocate the stable operation UUID when building a proposal, include its application-generated marker in the persisted body, and hash a canonical representation of the entire mutation payload. Display meaningful user-facing content; the marker is a technical annotation, not a user instruction. Never regenerate content after approval.

Approval expires 30 minutes after proposal creation. A named approver can act on a proposal in an allowed channel; the initiator need not be an approver. Unauthorized clicks receive a private denial and do not change shared state. Empty approver configuration disables actionable drafts. Recheck authorization and repository/issue eligibility before dispatch. A target closed, transferred, inaccessible, or replaced since drafting requires a fresh review; the MVP allows progress comments only on open issues.

Issue creation includes a concise title, summary, task/decision/blocker/deadline details when present, source thread link, related issue/PR links, and evidence-backed investigation steps. At most one verified assignee; no label creation, milestone manipulation, or follow-up scheduling. Comment updates include changed coordination facts and source links without overwriting prior content.

## Hard limits and defaults

| Setting | Default |
|---|---|
| Slack messages per invocation | 50, complete pagination required |
| GitHub candidates | 5 combined issues/PRs |
| GitHub search attempts | 2 queries, scoped to one mapped repository |
| Model requests per analysis | 2 maximum, including failed/repair calls |
| Input tokens per model request | 12,000 maximum |
| Output tokens per model request | 2,000 maximum, including provider-counted reasoning where applicable |
| Model request timeout | 30 seconds |
| Proposal lifetime | 30 minutes |
| Source snapshot retention | At most 24 hours |
| Proposal body retention | 7 days |
| Source timezone | Configured IANA workspace timezone; absent configuration prevents resolution of relative deadlines |

Do not silently switch to a more expensive model, truncate evidence needed for a claim, or convert provider errors into synthetic successes. Provider rate-limit waits can exceed the normal demo latency; show a queued/failure state rather than inventing completion.

## Partner scope

| ID | Partner behavior | Admission rule |
|---|---|---|
| OPT-01 | Auth0 login with explicit subject-to-tenant mapping | Only the read-only inspector; no Slack approval authority |
| OPT-02 | CopilotKit explains one selected persisted proposal and its evidence | Auth0-protected server loads all authorized context; no mutation tools |
| OPT-03 | Exa retrieves up to 3 public documentation references | User approves the exact sanitized query before external transmission; independent from GitHub approval |
| OPT-04 | Ambiguous AI supplies an allowlisted demo runbook as read-only context | Dedicated permitted dataset and verified API; no mail, chat, calendar or task writes |
| OPT-05 | Mozilla.ai evaluates synthetic run output | Offline tooling only; no production Python service or unapproved private-data export |

OpenAI via OpenRouter and Trigger.dev are the selected core services. Optional integrations are attempted in roadmap order and disabled if their setup/implementation cannot fit. [docs/INTEGRATIONS.md](INTEGRATIONS.md) defines actual usage evidence and configuration. No judging rule requires a particular partner.

## Out of scope

Continuous monitoring; slash commands; DMs and Slack Connect/shared channels; additional workplace products; autonomous consequential actions; issue PATCH/close/delete; comment edits; PR merges; deployments; web-based GitHub approval; full task management; vector search; general document ingestion; SaaS billing; enterprise onboarding; multiple workflow engines; duplicate inference routes.

## Completion definitions

Documentation complete means every required behavior maps to a task and test, contracts are internally consistent, and links resolve. Code complete means the required MVP implementation and focused tests pass; optional work is either demonstrated or disabled and marked deferred. Demo ready additionally requires both real integration paths, replay evidence, the release matrix, and rehearsal. None of these claims can substitute for another.
