export type ResultNotification = {
  channelId: string;
  messageTs: string;
  text: string;
};

export type NotificationOperation = {
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "STALE";
  action: "CREATE_ISSUE" | "ADD_PROGRESS_COMMENT";
  externalUrl?: string | null;
  errorCode?: string | null;
  resolutionNote?: string | null;
};

export interface SlackResultClient {
  updateMessage(input: ResultNotification): Promise<void>;
}

export function renderResultNotification(input: NotificationOperation): string {
  if (input.state === "SUCCEEDED") return `Signal completed ${input.action === "CREATE_ISSUE" ? "issue creation" : "the progress comment"}. ${input.externalUrl ?? "Result URL unavailable."}`;
  if (input.state === "UNKNOWN") return `Signal needs reconciliation before any further GitHub action. ${input.resolutionNote ?? "The provider result is uncertain; no retry was made."}`;
  if (input.state === "STALE") return "Signal did not execute this proposal because its target or authorization became stale.";
  return `Signal could not complete ${input.action === "CREATE_ISSUE" ? "issue creation" : "the progress comment"}. ${input.errorCode ?? "The provider rejected the request."}`;
}

export async function deliverResultNotification(
  input: ResultNotification,
  operation: NotificationOperation,
  client: SlackResultClient,
): Promise<void> {
  if (!input.channelId.trim() || !input.messageTs.trim()) throw new Error("notification_target_invalid");
  await client.updateMessage({ ...input, text: renderResultNotification(operation) });
}
