import { classifyGitHubPullRequestWebhook } from "../../../../adapters/github-webhook";
import type { acceptObserverEvent, resolveGitHubObserverTenant } from "../../../../db/repositories";
import { createObserverEventInput } from "../../../../domain/observer-events";
import { finishIngress, IngressError, ingressError, isRecord, parseObject, readSignedBody, RequestDeadline, type Connection, type IngressDependencies, type StoredJob } from "../../_lib/ingress";

export interface GitHubWebhookDependencies extends IngressDependencies {
  webhookSecret: () => string;
  resolveGitHubObserverTenant: typeof resolveGitHubObserverTenant;
  acceptObserverEvent: typeof acceptObserverEvent;
}

export function createGitHubWebhookHandler(dependencies: GitHubWebhookDependencies) {
  return async (request: Request): Promise<Response> => {
    const deadline = new RequestDeadline(dependencies.timeoutMs);
    let connection: Connection | undefined;
    let job: StoredJob | undefined;
    try {
      const rawBody = await readSignedBody(request, { provider: "github", secret: dependencies.webhookSecret(), deadline });
      const payload = parseObject(rawBody);
      const event = request.headers.get("x-github-event") ?? "";
      const delivery = request.headers.get("x-github-delivery") ?? "";
      if (!event || !/^[A-Za-z0-9_-]{1,128}$/.test(delivery)) throw new IngressError(400);
      if (isRecord(payload.sender) && payload.sender.type === "Bot") return Response.json({ ok: true }, { status: 202 });
      const classification = classifyGitHubPullRequestWebhook(rawBody, { event, delivery });
      if (classification.kind === "ignore") {
        if (classification.reason === "missing_fields") throw new IngressError(400);
        return Response.json({ ok: true }, { status: 202 });
      }
      if (!isRecord(payload.repository) || payload.repository.full_name !== `${classification.owner}/${classification.repo}`) throw new IngressError(400);
      deadline.check();
      connection = dependencies.createDb();
      const { db } = connection;
      const tenantId = await deadline.run(() => dependencies.resolveGitHubObserverTenant(db, { repositoryId: classification.repositoryId, installationId: classification.installationId }));
      if (!tenantId?.trim() || tenantId !== tenantId.trim()) return Response.json({ ok: true }, { status: 202 });
      const input = createObserverEventInput({ tenantId, source: "github", providerEventId: classification.deliveryId, eventType: "pull_request", repositoryId: classification.repositoryId, repositoryOwner: classification.owner, repositoryName: classification.repo, installationId: classification.installationId, pullRequestNumber: classification.pullRequestNumber, actorId: classification.senderLogin, rawBody });
      const accepted = await deadline.run(() => dependencies.acceptObserverEvent(db, input));
      if (!accepted.jobId || typeof accepted.duplicate !== "boolean") throw new IngressError(503);
      job = { tenantId, jobId: accepted.jobId, taskId: "signal.observe-event", schemaVersion: 1 };
      return Response.json({ ok: true, duplicate: accepted.duplicate });
    } catch (error) { return ingressError(error, "github", "Observer unavailable"); }
    finally {
      deadline.close();
      finishIngress(dependencies, connection, job);
    }
  };
}
