import type { Analysis, Mutation } from "../domain/contracts";

export type SlackBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "actions"; elements: Array<{ type: "button"; action_id: string; text: { type: "plain_text"; text: string }; value: string; style?: "primary" | "danger" }> };

export interface ProposalCardInput {
  proposalId: string;
  version: number;
  mutation?: Mutation;
  analysis: Analysis;
  analysisDurationMs: number;
  executable: boolean;
  status?: string;
}

export interface ProposalCard {
  blocks: SlackBlock[];
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function withoutOperationMarker(value: string): string {
  return value.replace(/\s*<!--\s*signal-operation:[^>]*-->/gi, "").trim();
}

function compact(value: string, limit: number): string {
  const clean = withoutOperationMarker(value);
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function destination(mutation: Mutation | undefined): string {
  if (!mutation) return "No executable action";
  return mutation.kind === "CREATE_ISSUE"
    ? `Create issue in ${mutation.owner}/${mutation.repo}`
    : `Comment on ${mutation.owner}/${mutation.repo}#${mutation.issueNumber}`;
}

function bodySummary(mutation: Mutation | undefined): string {
  if (!mutation) return "No proposal was created. Clarify the thread and invoke Signal again.";
  const body = compact(mutation.body, 1_200);
  return mutation.kind === "CREATE_ISSUE"
    ? `*${escapeText(mutation.title)}*\n${escapeText(body)}`
    : escapeText(body);
}

function evidenceLinks(analysis: Analysis): string[] {
  const links = new Set<string>();
  for (const fact of [...analysis.decisions, ...analysis.tasks, ...analysis.blockers]) {
    for (const evidence of fact.evidence) links.add(evidence.permalink);
  }
  return [...links].slice(0, 5);
}

export function renderProposalCard(input: ProposalCardInput): ProposalCard {
  const uncertainties = input.analysis.uncertainties.length > 0
    ? `*Uncertainty:* ${input.analysis.uncertainties.map(escapeText).join("; ")}`
    : "No unresolved uncertainty reported.";
  const evidence = evidenceLinks(input.analysis);
  const sourceText = evidence.length > 0
    ? `Sources: ${evidence.map((link, index) => `<${link}|${index + 1}>`).join(" ")}`
    : "Sources: none";
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*Signal proposal* · ${escapeText(destination(input.mutation))}\n${input.executable ? "Ready for review" : escapeText(input.status ?? "Not executable")}` } },
    { type: "section", text: { type: "mrkdwn", text: bodySummary(input.mutation) } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${uncertainties}\n${sourceText}\nAnalysis: ${input.analysisDurationMs} ms · version ${input.version}` }] },
  ];
  if (input.executable) {
    const value = `${input.proposalId}:${input.version}`;
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", action_id: "signal.review_proposal", text: { type: "plain_text", text: "Review" }, value, style: "primary" },
        { type: "button", action_id: "signal.dismiss_proposal", text: { type: "plain_text", text: "Dismiss" }, value, style: "danger" },
      ],
    });
  }
  return { blocks };
}
