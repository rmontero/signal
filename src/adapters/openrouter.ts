export type OpenRouterErrorCode =
  | "openrouter_configuration"
  | "openrouter_input_too_large"
  | "openrouter_timeout"
  | "openrouter_rate_limited"
  | "openrouter_unavailable"
  | "openrouter_rejected"
  | "openrouter_invalid_output";

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  readonly status?: number;

  constructor(code: OpenRouterErrorCode, message: string, status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.status = status;
  }
}

export interface OpenRouterCompletionInput {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface OpenRouterStructuredClient {
  readonly modelVersion?: string;
  complete(input: OpenRouterCompletionInput): Promise<unknown>;
}

interface OpenRouterClientOptions {
  apiKey: string | undefined;
  model: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxInputChars?: number;
}

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 48_000;
const MAX_OUTPUT_TOKENS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return undefined;
  return value.error.message;
}

function parseJsonBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function validateOptions(options: OpenRouterClientOptions): void {
  if (!options.apiKey?.trim() || typeof options.model !== "string" || !options.model.trim()) {
    throw new OpenRouterError("openrouter_configuration", "OpenRouter is not configured");
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new OpenRouterError("openrouter_configuration", "Invalid OpenRouter timeout");
  }
  if (options.maxInputChars !== undefined && (!Number.isInteger(options.maxInputChars) || options.maxInputChars <= 0)) {
    throw new OpenRouterError("openrouter_configuration", "Invalid OpenRouter input limit");
  }
  try {
    const endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    if (endpoint.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new OpenRouterError("openrouter_configuration", "Invalid OpenRouter endpoint");
  }
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function parseCompletion(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
    throw new OpenRouterError("openrouter_invalid_output", "OpenRouter returned no structured completion");
  }
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    throw new OpenRouterError("openrouter_invalid_output", "OpenRouter returned an invalid completion");
  }
  try {
    return JSON.parse(first.message.content) as unknown;
  } catch {
    throw new OpenRouterError("openrouter_invalid_output", "OpenRouter returned invalid JSON");
  }
}

export function createOpenRouterClient(options: OpenRouterClientOptions): OpenRouterStructuredClient {
  validateOptions(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;

  return {
    modelVersion: options.model,
    async complete(input): Promise<unknown> {
      const inputChars = input.system.length + input.user.length;
      if (inputChars > maxInputChars) {
        throw new OpenRouterError("openrouter_input_too_large", "OpenRouter input exceeds the configured limit");
      }

      const requestBody = {
        model: options.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        provider: { require_parameters: true },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: input.schemaName,
            strict: true,
            schema: input.schema,
          },
        },
      };
      const request = withTimeout(input.signal, timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody),
            redirect: "error",
            signal: request.signal,
          });
        } catch (error: unknown) {
          if (request.didTimeout()) {
            throw new OpenRouterError("openrouter_timeout", "OpenRouter request timed out");
          }
          if (error instanceof OpenRouterError) throw error;
          throw new OpenRouterError("openrouter_unavailable", "OpenRouter request failed");
        }

        const bodyText = await response.text();
        const body = parseJsonBody(bodyText);
        if (response.status === 429) {
          throw new OpenRouterError("openrouter_rate_limited", "OpenRouter rate limit reached", response.status);
        }
        if (response.status >= 500) {
          throw new OpenRouterError("openrouter_unavailable", "OpenRouter is unavailable", response.status);
        }
        if (!response.ok) {
          const category = response.status === 400 || response.status === 422
            ? "openrouter_rejected"
            : "openrouter_unavailable";
          throw new OpenRouterError(category, "OpenRouter rejected the request", response.status);
        }
        if (responseMessage(body)) {
          throw new OpenRouterError("openrouter_rejected", "OpenRouter rejected the response", response.status);
        }
        return parseCompletion(body);
      } finally {
        request.cleanup();
      }
    },
  };
}
