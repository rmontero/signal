# Original Signal product brief

Historical product input. The current scope and user decisions are defined in [the north star](../../north_star.md) and [product requirements](../PRODUCT.md).

Signal
An AI agent that turns scattered workplace conversations into coordinated action
Most teams do not have an information problem. They have a coordination problem.
Important decisions are buried in Slack threads, email, meeting notes, tickets, documents, and calendars. People spend hours figuring out what changed, who owns what, what is blocked, and what needs to happen next.
Signal is an AI agent that lives inside the tools where teams already work and continuously turns conversation into action.
Instead of asking people to open another chatbot, Signal participates in existing channels such as Slack, Teams, email, GitHub, and calendars.
When Signal detects something actionable, it can:
Identify decisions
Extract commitments
Detect blockers
Find missing owners
Identify deadlines
Connect related conversations
Recommend the next action
Create tasks or issues
Schedule follow-ups
Notify the right person
Escalate unresolved blockers
The key idea is simple:
The agent should not wait for you to ask what is happening. It should understand what is happening around you.

Example
Imagine an engineering team discussing a production issue in Slack.
A developer writes:
"The authentication bug appears to come from the new token refresh logic. Ana is checking the mobile client. We need to decide whether to roll back before tomorrow's release."
Signal detects:
Incident: Authentication regression
Owner: Ana
Decision required: Roll back or patch
Deadline: Before tomorrow's release
Related context: Recent GitHub changes to token refresh
Risk: Release blocker
Signal can respond directly in the Slack thread:
I found three recent changes related to token refresh. PR #1842 introduced the new refresh behavior. Ana is currently investigating the mobile client.
This appears to block tomorrow's release.
I can:
create an incident issue,
assign Ana,
attach the relevant PRs,
schedule a decision checkpoint for 4 PM.
The user clicks Create Incident.
Signal creates the GitHub issue, links the Slack discussion, adds the relevant pull requests, and schedules the follow-up.
The agent has moved from conversation to coordinated action.

Why this fits "Agents, Everywhere"
Signal does not live in a standalone AI application.
It lives across:
Slack → GitHub → Calendar → Email
The conversation becomes the interface.
Slack provides the context.
GitHub provides engineering state.
Calendar provides time.
The agent connects them.
That is what makes the context valuable. The agent understands not only what someone said, but where they said it, who was involved, what code changed, what deadlines exist, and what actions are possible.

Hackathon MVP
The hackathon version should stay deliberately small.
Use only:
Slack + GitHub
The MVP workflow:
Signal receives a Slack thread.
OpenAI analyzes the conversation.
The agent extracts:
decisions
tasks
owners
blockers
deadlines
The agent searches GitHub for related issues, PRs, or commits.
It generates a compact action card in Slack.
The user approves an action.
Signal creates or updates the corresponding GitHub issue.
That is enough for a compelling working demo.
Do not build a giant enterprise platform during the hackathon.
Build one workflow that works extremely well.

Architecture
Interaction layer
Slack bot or Slack application.
Signal listens only when:
tagged with @Signal
added to a specific thread
invoked with a command such as /signal
This prevents the agent from becoming noisy.
Agent layer
Use the OpenAI API as the reasoning and orchestration layer.
The agent receives:
Slack conversation
channel metadata
participants
GitHub repository context
available actions
The agent produces structured output such as:
{
  "summary": "Authentication regression affecting token refresh",
  "tasks": [
    {
      "description": "Investigate mobile token refresh",
      "owner": "Ana",
      "priority": "high"
    }
  ],
  "blockers": [
    "Tomorrow's production release"
  ],
  "recommended_actions": [
    "create_github_issue",
    "link_pull_requests"
  ]
}
Tool layer
Expose tools to the agent such as:
search_github()
get_pull_request()
create_issue()
update_issue()
assign_issue()
The model decides which tools are appropriate.
For destructive or consequential actions, require human confirmation.
Context layer
Give the agent contextual information automatically:
Current Slack channel
Current Slack thread
Participants
Repository
Recent pull requests
Open issues
Current date
This eliminates the typical chatbot interaction:
"Which repository?"
"What issue?"
"Can you paste the conversation?"
The environment itself provides the context.

Optional use of hackathon partners
The project can naturally demonstrate several technologies from the event.
OpenAI
Agent reasoning, structured extraction, tool calling, summarization, and action planning.
CopilotKit
Render an interactive action panel showing proposed agent actions.
Exa
Search external documentation when a discussion references an unfamiliar API, library, or error.
Example:
"This appears related to a breaking change introduced in React Router."
Signal could retrieve the relevant documentation automatically.
Trigger.dev
Run longer asynchronous workflows such as:
incident follow-ups
status checks
escalation
daily unresolved-blocker summaries
Auth0
Secure agent actions and enforce user-specific permissions.
A developer may be allowed to create an issue but not merge a pull request or trigger a deployment.
The important architectural principle
Signal should separate:
Reasoning
from
authority
The AI can decide:
"Creating an incident is probably the right next step."
But the human decides:
Approve
before Signal performs consequential actions.
This makes the agent useful without making it reckless.
Killer demo
Keep the demo under two minutes.
Scene 1
Show a Slack conversation:
Carlos: Login failures started after today's deploy.
Ana: I think it is related to token refresh.
Carlos: Can you check the mobile client?
Ana: Yes. We need an answer before the release meeting at 4.
Someone types:
@Signal
Scene 2
Signal responds:
Possible release blocker detected
Authentication failures may be related to token refresh.
Owner: Ana
Deadline: 4 PM
Related PR: #1842
Related issue: #713
Recommended action:
Create incident and assign Ana
Buttons:
Create Incident
Investigate
Ignore
Scene 3
Click:
Create Incident
Switch to GitHub.
A new issue already exists containing:
incident summary
owner
deadline
Slack conversation link
relevant PR
suggested investigation steps
Return to Slack.
Signal says:
Incident #742 created and assigned to Ana.
Done.
That demo communicates the entire product immediately.
Stretch goal
Add a second channel.
For example:
Slack + Calendar
Signal detects:
"We need an answer before the release meeting."
It discovers the meeting and offers:
Add incident status to today's 4 PM release meeting
Now the agent is crossing environments.
That reinforces the theme extremely well.
What makes Signal interesting
The interesting part is not summarization.
Every AI tool can summarize a Slack thread.
Signal answers a harder question:
"Given everything happening here, what should happen next?"
Then it helps make that action happen.
That is the transition from:
AI assistant
to
AI agent.
Potential tagline
Signal
Turn conversation into action.
Alternative:
Your team already knows what needs to happen. Signal makes sure it happens.
Submission description
Signal is an AI coordination agent that lives inside workplace conversations and converts them into action.
Instead of asking users to open another chatbot, Signal understands the context of Slack conversations, connects them with systems such as GitHub and calendars, identifies decisions, owners, blockers, and deadlines, and recommends concrete next steps.
Users remain in control. Signal proposes actions and executes them only after approval.
Our hackathon prototype connects Slack and GitHub. A developer can mention Signal inside a Slack thread, and the agent analyzes the discussion, discovers related engineering context, identifies required actions, and creates a structured GitHub issue with the relevant people, pull requests, deadlines, and conversation history.
Signal demonstrates a future where agents are not separate destinations. They become intelligent participants inside the tools where people already work.
Why I would mentor teams toward this type of project
The strongest projects for this hackathon will probably not be the ones with the most features.
They will have three characteristics:
Context
The agent understands something automatically because of where it lives.
Agency
The agent can actually do something, not simply generate text.
Restraint
The agent knows when a human should remain in control.
Signal demonstrates all three.
