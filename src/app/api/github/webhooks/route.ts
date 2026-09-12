import { classifyGitHubPullRequestWebhook, verifyGitHubWebhookSignature } from "../../../../adapters/github-webhook";
import { createDb } from "../../../../db/client";
import { acceptObserverEvent, resolveGitHubObserverTenant } from "../../../../db/repositories";
import { createObserverEventInput } from "../../../../domain/observer-events";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signatureResult = await verifyGitHubWebhookSignature({
    secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    rawBody,
    signature: request.headers.get("x-hub-signature-256") ?? "",
  });
  if (!signatureResult.ok) return json({ error: "Invalid request" }, 401);

  const classification = classifyGitHubPullRequestWebhook(rawBody, {
    event: request.headers.get("x-github-event") ?? "",
    delivery: request.headers.get("x-github-delivery") ?? "",
  });
  if (classification.kind !== "pull_request") return json({ ok: true }, 202);

  const { db, pool } = createDb();
  try {
    const tenantId = await resolveGitHubObserverTenant(db, {
      repositoryId: classification.repositoryId,
      installationId: classification.installationId,
    });
    if (!tenantId) return json({ ok: true }, 202);

    const input = createObserverEventInput({
      tenantId,
      source: "github",
      providerEventId: classification.deliveryId,
      eventType: "pull_request",
      repositoryId: classification.repositoryId,
      repositoryOwner: classification.owner,
      repositoryName: classification.repo,
      installationId: classification.installationId,
      pullRequestNumber: classification.pullRequestNumber,
      actorId: classification.senderLogin,
      rawBody,
    });
    const accepted = await acceptObserverEvent(db, input);
    return json({ ok: true, duplicate: accepted.duplicate });
  } catch {
    return json({ error: "Observer unavailable" }, 503);
  } finally {
    await pool.end();
  }
}
