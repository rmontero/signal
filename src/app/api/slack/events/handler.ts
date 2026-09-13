import { classifySlackEnvelope, classifySlackObserverEnvelope } from "../../../../adapters/slack-standalone.mts";
import type { acceptMention, acceptObserverEvent, resolveSlackObserverTenant } from "../../../../db/repositories";
import { createObserverEventInput } from "../../../../domain/observer-events";
import { finishIngress, IngressError, ingressError, isRecord, parseObject, readSignedBody, RequestDeadline, type Connection, type IngressDependencies, type StoredJob } from "../../_lib/ingress";

export interface SlackEventsDependencies extends IngressDependencies {
  signingSecret: () => string;
  resolveSlackObserverTenant: typeof resolveSlackObserverTenant;
  acceptMention: typeof acceptMention;
  acceptObserverEvent: typeof acceptObserverEvent;
}

export function createSlackEventsHandler(dependencies: SlackEventsDependencies) {
  return async (request: Request): Promise<Response> => {
    const deadline = new RequestDeadline(dependencies.timeoutMs);
    let connection: Connection | undefined;
    let job: StoredJob | undefined;
    try {
      const rawBody = await readSignedBody(request, { provider: "slack", secret: dependencies.signingSecret(), deadline });
      const envelope = parseObject(rawBody);
      if (typeof envelope.type !== "string" || !envelope.type) throw new IngressError(400);
      if (envelope.type === "url_verification") {
        if (typeof envelope.challenge !== "string" || !envelope.challenge) throw new IngressError(400);
        return Response.json({ challenge: envelope.challenge });
      }
      if (envelope.type !== "event_callback") return Response.json({ ok: true }, { status: 202 });
      if (!isRecord(envelope.event)) throw new IngressError(400);
      const event = envelope.event;
      // DMs, group DMs, bot/app events and message edits cannot trigger observation or analysis.
      if (event.bot_id || event.app_id || event.subtype || (typeof event.channel === "string" && event.channel.startsWith("D")) ||
        (event.channel_type !== undefined && !["channel", "group"].includes(event.channel_type as string))) return Response.json({ ok: true }, { status: 202 });
      const mention = classifySlackEnvelope(envelope);
      const classified = event.type === "app_mention" ? mention : classifySlackObserverEnvelope(envelope);
      if (classified.kind === "ignore" && classified.reason === "missing_fields") throw new IngressError(400);
      if (classified.kind !== "app_mention" && classified.kind !== "slack_message") return Response.json({ ok: true }, { status: 202 });
      deadline.check();
      connection = dependencies.createDb();
      const { db } = connection;
      const tenantId = await deadline.run(() => dependencies.resolveSlackObserverTenant(db, { slackTeamId: classified.teamId, channelId: classified.channelId }));
      if (!tenantId?.trim() || tenantId !== tenantId.trim()) return Response.json({ ok: true }, { status: 202 });
      const accepted = classified.kind === "app_mention"
        ? await deadline.run(() => dependencies.acceptMention(db, { tenantId, slackEventId: classified.eventId, slackTeamId: classified.teamId, channelId: classified.channelId, threadTs: classified.threadTs, messageTs: classified.messageTs, actorSlackId: classified.userId }))
        : await deadline.run(() => dependencies.acceptObserverEvent(db, createObserverEventInput({ tenantId, source: "slack", providerEventId: classified.eventId, eventType: "message", channelId: classified.channelId, threadTs: classified.threadTs, messageTs: classified.messageTs, actorId: classified.userId, rawBody }), classified.teamId));
      if (!accepted.jobId || typeof accepted.duplicate !== "boolean") throw new IngressError(503);
      job = { tenantId, jobId: accepted.jobId, taskId: classified.kind === "app_mention" ? "signal.analyze-thread" : "signal.observe-event", schemaVersion: 1 };
      return Response.json({ ok: true, duplicate: accepted.duplicate });
    } catch (error) { return ingressError(error, "slack", "Observer unavailable"); }
    finally {
      deadline.close();
      finishIngress(dependencies, connection, job);
    }
  };
}
