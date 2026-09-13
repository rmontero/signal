import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { SignalDb } from "../../../db/client";
import type { TaskInput } from "../../../domain/contracts";
import type { dispatchStoredOutboxJob } from "../../../trigger/outbox";

export type StoredJob = TaskInput & { taskId: string };
export type Connection = { db: SignalDb; pool: { end(): Promise<void> } };
export type AfterResponse = (work: () => Promise<void>) => void;
export interface IngressDependencies {
  createDb: () => Connection;
  after: AfterResponse;
  dispatchStoredOutboxJob: typeof dispatchStoredOutboxJob;
  timeoutMs?: number;
}

export class IngressError extends Error {
  constructor(readonly status: 400 | 401 | 413 | 503) { super("Ingress request failed"); }
}

/** One budget for body intake and foreground work, including nested service calls. */
export class RequestDeadline {
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs = 2_500) {
    this.expiresAt = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.controller.abort(), timeoutMs);
  }

  get signal(): AbortSignal { return this.controller.signal; }

  check(): void {
    if (this.signal.aborted || performance.now() >= this.expiresAt) throw new IngressError(503);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new IngressError(503));
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => { this.check(); return work(); }), aborted]);
      this.check();
      return result;
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
  } catch { /* Never include parser input or errors in the response. */ }
  throw new IngressError(400);
}

/** Authenticate original bytes before UTF-8 decoding, JSON parsing or form decoding. */
export async function readSignedBody(request: Request, input: {
  provider: "slack" | "github";
  secret: string;
  deadline: RequestDeadline;
  maxBytes?: number;
}): Promise<string> {
  const slack = input.provider === "slack";
  const signature = request.headers.get(slack ? "x-slack-signature" : "x-hub-signature-256") ?? "";
  const prefix = slack ? "v0=" : "sha256=";
  if (!input.secret || !(slack ? /^v0=[a-f0-9]{64}$/ : /^sha256=[a-f0-9]{64}$/).test(signature)) throw new IngressError(401);
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  if (slack && (!/^\d{1,16}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000)) throw new IngressError(401);

  const limit = input.maxBytes ?? 1024 * 1024;
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) throw new IngressError(413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await input.deadline.run(() => reader.read());
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new IngressError(413);
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      if (error instanceof IngressError) throw error;
      throw new IngressError(400);
    } finally { reader.releaseLock(); }
  }
  const bytes = Buffer.concat(chunks, size);
  const hmac = createHmac("sha256", input.secret);
  if (slack) hmac.update(`v0:${timestamp}:`);
  if (!timingSafeEqual(hmac.update(bytes).digest(), Buffer.from(signature.slice(prefix.length), "hex"))) throw new IngressError(401);
  try {
    // Keep a BOM intact; never authenticate a lossy or normalized reconstruction.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { throw new IngressError(400); }
}

export function ingressError(error: unknown, provider: "slack" | "github", unavailable: string): Response {
  const status = error instanceof IngressError ? error.status : 503;
  if (provider === "slack") return Response.json({ error: status === 503 ? unavailable : "Invalid request" }, { status });
  const code = status === 503 ? "observer_unavailable" : status === 413 ? "request_too_large" : "invalid_request";
  return Response.json({ error: { code, requestId: randomUUID() } }, { status });
}

/** Only a committed job may be passed here. Recovery owns failed/missed dispatches. */
export function finishIngress(dependencies: IngressDependencies, connection: Connection | undefined, job?: StoredJob): void {
  if (!connection) return;
  const close = async () => { try { await connection.pool.end(); } catch { /* No provider/DB error logging. */ } };
  try {
    dependencies.after(async () => {
      try {
        if (job) await dependencies.dispatchStoredOutboxJob(connection.db, job);
      } catch { /* Durable outbox recovery owns redispatch. */ }
      finally { await close(); }
    });
  } catch {
    // Registration failure must not turn a durable acceptance into an error.
    void close();
  }
}
