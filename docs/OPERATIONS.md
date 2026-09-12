# Operations runbook

Signal is a reviewable action service. Slack is the authority surface for GitHub approval; Auth0 and CopilotKit are read-only inspectors. Trigger.dev is the only background task engine and OpenRouter is the selected inference route. Optional integrations remain disabled unless configured and demonstrated.

## Normal recovery

Inspect a proposal, operation UUID, tenant, action type, payload hash, and status before intervening. An accepted event and dispatch job must be durable together. A GitHub result and Slack notification job must also be committed together. If a request or response is interrupted, mark the operation `UNKNOWN` and reconcile the stable operation marker and target before taking any further action. Never blindly retry a GitHub mutation. If reconciliation cannot prove the result, stop at `UNKNOWN`, record the reason and evidence IDs, and resolve manually with the named operator.

For an accepted proposal whose assignee was dropped by GitHub, retain the returned issue/comment result, surface the actual assignee state, and do not submit a second mutation. For an active `SENDING` lease, honor its owner and expiry, use fencing/lease checks, and recover only after BOTH the lease is expired and the owning Trigger attempt/run is confirmed terminal with no continuing retry attempt. An expired lease whose owner is still running remains blocked: do not POST, transition, or reconcile it. A crash before dispatch is an outbox gap: replay the durable job once under its idempotency key. A Slack notification failure is Slack-only: retry the notification from the persisted result and never repeat GitHub.

Manual resolution records the operation UUID, tenant, action, payload hash, observed provider result, reconciler query, operator, and decision. If reconciliation finds no marker, that absence is insufficient evidence to resend a POST; leave the operation `UNKNOWN` pending manual resolution. Revocation disables the relevant Slack installation or mapping and invalidates pending approvals; it does not erase the audit needed to explain an earlier result. Check for stale outbox rows, expired leases, unknown writes, notification failures, and provider rate limits during routine review.

## Data and security

Do not log source text, prompts, complete task payloads, credentials, callback bodies, or tokens. Use IDs, hashes, durations, and small status values. Retain source snapshots for at most 24 hours and proposal bodies for 7 days, then delete them with a verified cleanup job. Provider retention is separate and must be documented. Tenant context is explicit on every lookup and is rechecked at execution; a missing or mismatched tenant fails closed.

Treat Slack callbacks, browser inputs, retrieval results, and model output as untrusted. Verify signatures, actor, channel, tenant, proposal version, payload hash, and expiry at approval time. The model cannot own an approval transition or GitHub write. Only `CREATE_ISSUE` and `ADD_PROGRESS_COMMENT` are permitted. No issue patch, closure, merge, deployment, label creation, or silent owner guessing is an operational fallback.

Private input is never transmitted to Exa. Before any Exa request, the initiating Slack actor must approve the exact sanitized query. This separate consent does not require or grant GitHub approval authority. If sanitization, approval, configuration, or the provider response is uncertain, leave Exa disabled. Auth0/CopilotKit may explain authorized persisted proposals but cannot approve or mutate them. Ambiguous AI and Mozilla.ai remain read-only, synthetic, and optional.

## Rollback and disablement

For a bad release, disable intake and optional integrations, drain or pause new dispatch, and preserve the database, operation markers, provider IDs, and Slack/GitHub writes already made. Roll back application code and resume only after schema compatibility and reconciliation checks pass. Rolling back code must never attempt to undo an external issue or comment automatically. Revoke compromised credentials and rotate them through the hosting secret store; do not place replacements in logs or documents. If core dependencies are unavailable, show queued/failure state and keep the exact proposal for review rather than manufacturing success.

The four-hour implementation clock and protected two-hour finishing window are delivery controls. If preflight exceeds 30 minutes, record the blocker once and use local contract work. At hour four freeze new features. Optional setup has a 15-minute cap and cannot consume finishing time. Required authorization, tenant isolation, mutation recovery, and their tests remain release gates.
