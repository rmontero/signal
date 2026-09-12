# Two-minute demo

Use a configured, non-rate-limited Slack workspace and mapped GitHub repository. Use permitted test accounts playing Carlos and Ana in a disposable thread with synthetic content. Configure Ana's actual Slack ID as a named approver and map it explicitly to an eligible GitHub account. Do not claim a live issue number before GitHub returns it, and never fabricate URLs, partner results, or completion claims.

Post these messages before invoking Signal. Carlos posts the root message; select the real Ana account from Slack's mention picker where `@Ana` appears, rather than relying on a display-name string:

```text
We decided to investigate the staging token-refresh regression before Friday, September 18, 2026 at 15:00 America/Mexico_City. @Ana owns the mobile-client check. Blocker: Platform must confirm which token-refresh version is deployed before we can decide whether to roll back.
```

Ana replies in that thread:

```text
I can take the mobile-client check and will ask Platform to confirm the deployed version.
```

After both messages are visible, Carlos adds a separate `@Signal` mention in the same thread, selecting the installed app from Slack's mention picker. This ensures the first snapshot includes both source messages.

After the returned GitHub result, substitute the actual number shown by GitHub. For example, if the response says issue `#842`, the exact follow-up invocation is:

```text
Platform confirmed the new token-refresh version is deployed. The mobile-client check reproduces the regression, so the release remains blocked. @Signal update #842
```

The number `842` is only an example; the demo operator must use the actual returned issue number and URL.

1. In under 20 seconds, Carlos posts a thread with a concrete task, owner Ana, a blocker, and a deadline, then mentions `@Signal`. Signal reads the invoked thread and shows a compact card with the mapped repository, evidence links, uncertainty, and exact issue draft.
2. In the next 25 seconds, open Review. Show the immutable title/body, source thread, related candidates, and named approver. Ana approves from Slack. Wait for the returned GitHub issue URL/ID and assignee, then show Signal’s confirmation in the original thread.
3. In the next 25 seconds, Carlos adds a changed coordination fact and invokes `@Signal update` for the returned issue. Review and approve the exact progress comment. Show the returned comment URL and that the issue’s existing fields are unchanged.
4. In the final 30 seconds, replay the original Slack delivery, click the approval twice, and start the task twice. Show the recorded result and deduplication evidence: one issue and one comment. If a provider is slow, show queued state and stop at the truthful status.

The rehearsal uses synthetic conversation content and real provider IDs captured after each step. It does not use fake issue numbers or pretend a disabled optional integration succeeded. A clean run requires both create and progress-comment paths plus replay evidence. If live Slack/GitHub credentials or rate limits prevent this, demonstrate the same screens with clearly labeled local fixtures, mark the live gate `NOT RUN`, and identify the exact blocker. Local fixtures never count as live integration proof.
