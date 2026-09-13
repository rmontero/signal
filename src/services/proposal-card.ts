import { AnalysisSchema, canonicalJson, MutationSchema, payloadHash, prepareMutation, ProposalStateSchema, type Analysis, type Mutation } from "../domain/contracts";

type SlackText = { type: "mrkdwn"; text: string } | { type: "plain_text"; text: string; emoji: false };

export type SlackBlock =
  | { type: "section"; text: SlackText; expand?: boolean }
  | { type: "context"; elements: SlackText[] }
  | { type: "actions"; elements: Array<{ type: "button"; action_id: string; text: { type: "plain_text"; text: string }; value: string; style?: "primary" | "danger" }> };

export interface ProposalCardInput {
  proposalId: string;
  version: number;
  mutation?: Mutation;
  analysis: Analysis;
  analysisDurationMs?: number | null;
  executable: boolean;
  status?: string;
}

export interface ProposalCard {
  blocks: SlackBlock[];
}

export interface PersistedProposalCardInput {
  proposalId: string;
  version: number;
  mutation: unknown;
  analysis: unknown;
  state: string;
  expiresAt: Date | string;
  analysisDurationMs?: number | null;
  now?: Date;
  tenantId?: string;
  operationId?: string;
  payloadHash?: string;
}

export class ProposalCardError extends Error {
  readonly code = "proposal_card_invalid";

  constructor() {
    super("Persisted proposal cannot be rendered completely and safely");
    this.name = "ProposalCardError";
  }
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function textBlocks(value: string): SlackBlock[] {
  // Split after escaping, but never inside an entity or a Unicode code point.
  // plain_text also neutralizes backticks, emphasis and Slack control syntax.
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    const escaped = escapeText(character);
    if (chunk.length + escaped.length > 3_000) {
      chunks.push(chunk);
      if (chunks.length >= 50) throw new ProposalCardError();
      chunk = "";
    }
    chunk += escaped;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((text) => ({ type: "section", text: { type: "plain_text", text, emoji: false }, expand: true }));
}

function destination(mutation: Mutation | undefined): string {
  if (!mutation) return "No executable action";
  return mutation.kind === "CREATE_ISSUE"
    ? `Create issue in ${mutation.owner}/${mutation.repo}`
    : `Comment on ${mutation.owner}/${mutation.repo}#${mutation.issueNumber}`;
}

function evidenceLinks(analysis: Analysis): string[] {
  const links = new Set<string>();
  for (const fact of [...analysis.decisions, ...analysis.tasks, ...analysis.blockers]) {
    for (const evidence of fact.evidence) links.add(evidence.permalink);
  }
  return [...links];
}

export function renderProposalCard(input: ProposalCardInput): ProposalCard {
  if (!input.proposalId.trim() || input.proposalId.length > 200 || !Number.isSafeInteger(input.version) || input.version <= 0 || (input.executable && !input.mutation)) throw new ProposalCardError();
  if (input.mutation) {
    const parsed = MutationSchema.safeParse(input.mutation);
    // Parsing is validation only: never normalize the material being reviewed.
    if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(input.mutation)) throw new ProposalCardError();
  }
  if (!AnalysisSchema.safeParse(input.analysis).success) throw new ProposalCardError();
  const uncertainties = input.analysis.uncertainties.length > 0
    ? `Uncertainty: ${input.analysis.uncertainties.join("; ")}`
    : "No unresolved uncertainty reported.";
  const evidence = evidenceLinks(input.analysis);
  const sourceText = evidence.length > 0
    ? `Sources:\n${evidence.join("\n")}`
    : "Sources: none";
  const duration = typeof input.analysisDurationMs === "number" && Number.isFinite(input.analysisDurationMs) && input.analysisDurationMs >= 0 ? `${input.analysisDurationMs} ms` : "unavailable";
  const blocks: SlackBlock[] = textBlocks(`Signal proposal · ${destination(input.mutation)}\n${input.executable ? "Ready for review" : (input.status ?? "Not executable")}`);
  if (input.mutation) {
    if (input.mutation.kind === "CREATE_ISSUE") {
      blocks.push(...textBlocks("Issue title"), ...textBlocks(input.mutation.title));
      blocks.push(...textBlocks(`Assignee: ${input.mutation.assignees[0] ?? "Unassigned"}`));
    }
    blocks.push(...textBlocks(input.mutation.kind === "CREATE_ISSUE" ? "Issue body" : "Progress comment"), ...textBlocks(input.mutation.body));
  } else {
    blocks.push(...textBlocks("No proposal was created. Clarify the thread and invoke Signal again."));
  }
  blocks.push(...textBlocks(uncertainties), ...textBlocks(sourceText), ...textBlocks(`Analysis: ${duration} · version ${input.version}`));
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
  if (blocks.length > 50) throw new ProposalCardError();
  return { blocks };
}

/** Pure outbox renderer. All action material comes from the persisted proposal. */
export function renderPersistedProposalCard(input: PersistedProposalCardInput): ProposalCard {
  const mutation = MutationSchema.safeParse(input.mutation);
  const analysis = AnalysisSchema.safeParse(input.analysis);
  const state = ProposalStateSchema.safeParse(input.state);
  const expiry = new Date(input.expiresAt).getTime();
  const now = (input.now ?? new Date()).getTime();
  if (!mutation.success || !analysis.success || !state.success || !Number.isFinite(expiry) || !Number.isFinite(now) || canonicalJson(mutation.data) !== canonicalJson(input.mutation)) throw new ProposalCardError();
  if (input.tenantId !== undefined || input.operationId !== undefined || input.payloadHash !== undefined) {
    if (!input.tenantId || !input.operationId || !input.payloadHash) throw new ProposalCardError();
    try {
      if (canonicalJson(prepareMutation(mutation.data, input.operationId)) !== canonicalJson(input.mutation) || payloadHash({ schemaVersion: 1, tenantId: input.tenantId, operationId: input.operationId, version: input.version, mutation: mutation.data }) !== input.payloadHash) throw new ProposalCardError();
    } catch {
      throw new ProposalCardError();
    }
  }
  const executable = state.data === "PENDING" && expiry > now;
  return renderProposalCard({
    proposalId: input.proposalId, version: input.version, mutation: input.mutation as Mutation,
    analysis: analysis.data, analysisDurationMs: input.analysisDurationMs, executable,
    status: state.data === "PENDING" && expiry <= now ? "EXPIRED" : state.data,
  });
}
