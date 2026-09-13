export type NotificationContext = {
  tenantId: string;
  operationId: string;
  proposalId: string;
  channelId: string;
  messageTs: string;
};

export type ResultNotification = {
  channelId: string;
  messageTs: string;
  text: string;
  context?: NotificationContext;
};

export type NotificationOperation = {
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "STALE";
  action: "CREATE_ISSUE" | "ADD_PROGRESS_COMMENT";
  externalUrl?: string | null;
  errorCode?: string | null;
  resolutionNote?: string | null;
  actualAssignees?: string[] | null;
  assigneeMismatch?: boolean | null;
  context?: NotificationContext;
};

export interface SlackResultClient {
  updateMessage(input: ResultNotification): Promise<void>;
}

function resultUrl(input: NotificationOperation): string {
  const match = typeof input.externalUrl === "string" && /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/issues\/[1-9]\d*(#issuecomment-[1-9]\d*)?$/.exec(input.externalUrl);
  return match && Boolean(match[1]) === (input.action === "ADD_PROGRESS_COMMENT") ? input.externalUrl! : "Result URL unavailable.";
}

function resolutionMessage(errorCode?: string | null): string {
  switch (errorCode) {
    case "reconcile_not_found": return "No matching operation marker was found; manual review is required.";
    case "reconcile_ambiguous_marker": return "Operation markers did not uniquely match the approved action; manual review is required.";
    case "reconcile_target_changed": return "The repository identity changed; manual review is required.";
    case "reconcile_read_failed": return "Provider read-back was incomplete or unavailable.";
    case "reconcile_attempt_active":
    case "reconcile_attempt_running": return "The original attempt has not finished safely; reconciliation is waiting.";
    default: return "The provider result is uncertain; no retry was made.";
  }
}

export function renderResultNotification(input: NotificationOperation): string {
  if (!["CREATE_ISSUE", "ADD_PROGRESS_COMMENT"].includes(input.action) || !["SUCCEEDED", "FAILED", "UNKNOWN", "STALE"].includes(input.state)) throw new Error("notification_operation_invalid");
  if (input.state === "SUCCEEDED") {
    let assignment = "";
    if (input.action === "CREATE_ISSUE") {
      const assignees = input.actualAssignees;
      assignment = Array.isArray(assignees) && assignees.every((login) => typeof login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login))
        ? ` Actual assignees: ${assignees.length ? assignees.join(", ") : "none"}.`
        : " Assignee result unavailable.";
      if (input.assigneeMismatch === true) assignment += " GitHub's returned assignees differ from the approved proposal.";
    }
    return `Signal completed ${input.action === "CREATE_ISSUE" ? "issue creation" : "the progress comment"}. ${resultUrl(input)}${assignment}`;
  }
  if (input.state === "UNKNOWN") return `Signal needs reconciliation before any further GitHub action. ${resolutionMessage(input.errorCode)}`;
  if (input.state === "STALE") return "Signal did not execute this proposal because its target or authorization became stale.";
  return `Signal could not complete ${input.action === "CREATE_ISSUE" ? "issue creation" : "the progress comment"}. The provider rejected the request.`;
}

export async function deliverResultNotification(
  input: ResultNotification,
  operation: NotificationOperation,
  client: SlackResultClient,
): Promise<void> {
  if (typeof input.channelId !== "string" || !/^[CG][A-Z0-9]+$/.test(input.channelId) || typeof input.messageTs !== "string" || !/^\d+\.\d{6}$/.test(input.messageTs)) throw new Error("notification_target_invalid");
  // Optional for existing callers; once supplied, neither side may omit any binding.
  if (input.context !== undefined || operation.context !== undefined) {
    const expected = input.context;
    const actual = operation.context;
    if (!expected || !actual) throw new Error("notification_context_invalid");
    for (const key of ["tenantId", "operationId", "proposalId", "channelId", "messageTs"] as const) {
      if (typeof expected[key] !== "string" || !expected[key].trim() || expected[key] !== expected[key].trim() || expected[key] !== actual[key]) throw new Error("notification_context_invalid");
    }
    if (expected.channelId !== input.channelId || expected.messageTs !== input.messageTs) throw new Error("notification_context_invalid");
  }
  const text = renderResultNotification(operation);
  try {
    // Whitelist the transport fields: persisted context and mutation data stay local.
    await client.updateMessage({ channelId: input.channelId, messageTs: input.messageTs, text });
  } catch { throw new Error("notification_delivery_failed"); }
}
