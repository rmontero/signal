import { classifySlackObserverEnvelope, verifySlackRequestSignature } from "../../../../adapters/slack-standalone.mts";
import { acceptObserverEvent, resolveSlackObserverTenant } from "../../../../db/repositories";
import { createDb } from "../../../../db/client";
import { createObserverEventInput } from "../../../../domain/observer-events";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signatureResult = await verifySlackRequestSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    timestamp,
    rawBody,
    signature,
  });
  if (!signatureResult.ok) return json({ error: "Invalid request" }, 401);

  let envelope: Parameters<typeof classifySlackObserverEnvelope>[0];
  try {
    envelope = JSON.parse(rawBody) as Parameters<typeof classifySlackObserverEnvelope>[0];
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    return json({ challenge: envelope.challenge });
  }

  const classification = classifySlackObserverEnvelope(envelope);
  if (classification.kind !== "slack_message") return json({ ok: true }, 202);

  const { db, pool } = createDb();
  try {
    const tenantId = await resolveSlackObserverTenant(db, {
      slackTeamId: classification.teamId,
      channelId: classification.channelId,
    });
    if (!tenantId) return json({ ok: true }, 202);

    const input = createObserverEventInput({
      tenantId,
      source: "slack",
      providerEventId: classification.eventId,
      eventType: "message",
      channelId: classification.channelId,
      threadTs: classification.threadTs,
      messageTs: classification.messageTs,
      actorId: classification.userId,
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
