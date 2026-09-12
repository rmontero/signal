export type GitHubWebhookSignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing_secret" | "invalid_signature" };

export async function verifyGitHubWebhookSignature(input: {
  secret: string;
  rawBody: string;
  signature: string;
}): Promise<GitHubWebhookSignatureResult> {
  if (!input.secret) return { ok: false, reason: "missing_secret" };
  if (!/^sha256=[a-f0-9]{64}$/.test(input.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input.rawBody),
  );
  const expected = `sha256=${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let difference = expected.length ^ input.signature.length;
  for (let index = 0; index < Math.max(expected.length, input.signature.length); index += 1) {
    difference |= (expected.charCodeAt(index) || 0) ^ (input.signature.charCodeAt(index) || 0);
  }
  return difference === 0 ? { ok: true } : { ok: false, reason: "invalid_signature" };
}

export type GitHubPullRequestWebhookClassification =
  | {
      kind: "pull_request";
      deliveryId: string;
      action: string;
      repositoryId: string;
      owner: string;
      repo: string;
      installationId: string;
      pullRequestNumber: number;
      senderLogin: string;
    }
  | { kind: "ignore"; reason: "unsupported_event" | "missing_fields" };

const SUPPORTED_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "closed",
  "ready_for_review",
  "converted_to_draft",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveIdentifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) return value;
  return undefined;
}

function providerLogin(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value) ? value : undefined;
}

export function classifyGitHubPullRequestWebhook(
  rawBody: string,
  headers: { event: string; delivery: string },
): GitHubPullRequestWebhookClassification {
  if (headers.event !== "pull_request") return { kind: "ignore", reason: "unsupported_event" };
  if (!headers.delivery.trim()) return { kind: "ignore", reason: "missing_fields" };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { kind: "ignore", reason: "missing_fields" };
  }

  if (!isRecord(payload) || typeof payload.action !== "string") {
    return { kind: "ignore", reason: "missing_fields" };
  }
  if (!SUPPORTED_ACTIONS.has(payload.action)) {
    return { kind: "ignore", reason: "unsupported_event" };
  }
  const repository = isRecord(payload.repository) ? payload.repository : undefined;
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : undefined;
  const installation = isRecord(payload.installation) ? payload.installation : undefined;
  const sender = isRecord(payload.sender) ? payload.sender : undefined;
  const fullName = repository?.full_name;
  const [owner, repo] = typeof fullName === "string" ? fullName.split("/") : [];
  const repositoryId = positiveIdentifier(repository?.id);
  const installationId = positiveIdentifier(installation?.id);
  const pullRequestNumber = pullRequest?.number;
  const senderLogin = providerLogin(sender?.login);

  if (
    !repositoryId || !owner || !repo ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) ||
    !installationId ||
    typeof pullRequestNumber !== "number" ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !senderLogin
  ) {
    return { kind: "ignore", reason: "missing_fields" };
  }

  return {
    kind: "pull_request",
    deliveryId: headers.delivery,
    action: payload.action,
    repositoryId,
    owner,
    repo,
    installationId,
    pullRequestNumber,
    senderLogin,
  };
}
