import type { SlackBlock } from "../services/proposal-card";
import type { ApprovalModal } from "../services/approve";
import type { ResultNotification, SlackResultClient } from "../services/notify";

export class SlackApiError extends Error {
  readonly providerCode?: string;
  constructor(message: string, providerCode?: string) {
    super(message);
    this.name = "SlackApiError";
    this.providerCode = providerCode;
  }
}

export interface SlackApiClient extends SlackResultClient {
  openModal(input: { triggerId: string; modal: ApprovalModal }): Promise<{ viewId: string }>;
  postMessage(input: { channelId: string; threadTs: string; text: string; blocks: SlackBlock[] }): Promise<{ messageTs: string }>;
}

function apiUrl(baseUrl: string, method: string): string {
  return new URL(method, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

async function callSlack(fetchImpl: typeof fetch, token: string, baseUrl: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(apiUrl(baseUrl, method), { method: "POST", headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error" });
  } catch {
    throw new SlackApiError("Slack request was unavailable");
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new SlackApiError("Slack returned invalid JSON"); }
  if (!response.ok || typeof payload !== "object" || payload === null || (payload as { ok?: unknown }).ok !== true) {
    const code = typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : undefined;
    throw new SlackApiError("Slack rejected the request", code);
  }
  return payload as Record<string, unknown>;
}

export function createSlackApiClient(options: { botToken: string; apiBaseUrl?: string; fetchImpl?: typeof fetch }): SlackApiClient {
  if (!options.botToken.trim()) throw new SlackApiError("Slack bot token is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new SlackApiError("Fetch is unavailable in this runtime");
  const baseUrl = options.apiBaseUrl ?? "https://slack.com/api";
  return {
    async openModal(input) {
      const payload = await callSlack(fetchImpl, options.botToken, baseUrl, "views.open", { trigger_id: input.triggerId, view: input.modal });
      const view = payload.view;
      if (typeof view !== "object" || view === null || typeof (view as { id?: unknown }).id !== "string") throw new SlackApiError("Slack returned an invalid modal identity");
      return { viewId: (view as { id: string }).id };
    },
    async updateMessage(input: ResultNotification) {
      await callSlack(fetchImpl, options.botToken, baseUrl, "chat.update", { channel: input.channelId, ts: input.messageTs, text: input.text });
    },
    async postMessage(input) {
      const payload = await callSlack(fetchImpl, options.botToken, baseUrl, "chat.postMessage", { channel: input.channelId, thread_ts: input.threadTs, text: input.text, blocks: input.blocks });
      const message = payload.message;
      if (typeof message !== "object" || message === null || typeof (message as { ts?: unknown }).ts !== "string") throw new SlackApiError("Slack returned an invalid message identity");
      return { messageTs: (message as { ts: string }).ts };
    },
  };
}
