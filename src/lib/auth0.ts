import "server-only";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { NextResponse } from "next/server.js";

type Auth0ClientOptions = NonNullable<ConstructorParameters<typeof Auth0Client>[0]>;
const unavailableMessage = "Authentication is unavailable.";

/** Server-only mapping of Signal's environment names to the installed v4 SDK. */
export function readAuth0Settings(env: Record<string, string | undefined> = process.env) {
  const required = (name: string): string => {
    const value = env[name];
    if (!value || value !== value.trim()) throw new Error(unavailableMessage);
    return value;
  };
  try {
    const secret = required("AUTH0_SECRET");
    if (!/^[a-f\d]{64}$/i.test(secret)) throw new Error(unavailableMessage);
    const base = new URL(required("AUTH0_BASE_URL"));
    const issuer = new URL(required("AUTH0_ISSUER_BASE_URL"));
    for (const url of [base, issuer]) {
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(unavailableMessage);
    }
    const localHttp = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && env.NODE_ENV !== "production";
    if ((base.protocol !== "https:" && !localHttp) || issuer.protocol !== "https:") throw new Error(unavailableMessage);
    return {
      secret, appBaseUrl: base.origin, domain: issuer.host,
      clientId: required("AUTH0_CLIENT_ID"), clientSecret: required("AUTH0_CLIENT_SECRET"),
    };
  } catch {
    // URL parsing errors can contain credentials; never expose their messages.
    throw new Error(unavailableMessage);
  }
}

function unsafeRedirectCharacters(value: string): boolean {
  return [...value].some((character) => character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Accept root-relative local paths only, including their query and fragment. */
export function validateReturnTo(value: unknown, appBaseUrl: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value !== value.trim() || value.length > 2048) return "/";
  try {
    if (unsafeRedirectCharacters(value) || unsafeRedirectCharacters(decodeURIComponent(value))) return "/";
    const origin = new URL(appBaseUrl).origin;
    const target = new URL(value, origin);
    if (target.origin !== origin) return "/";
    let pathname = target.pathname;
    // Check encoded separators and dot segments before returning a path that
    // another redirect layer could interpret as a protocol-relative URL.
    for (let depth = 0; depth < 5; depth++) {
      const normalized = new URL(pathname, origin);
      if (unsafeRedirectCharacters(pathname) || normalized.origin !== origin || normalized.pathname.startsWith("//")) return "/";
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) return target.pathname + target.search + target.hash;
      pathname = decoded;
    }
  } catch {
    // Malformed escapes and invalid URLs are not return destinations.
  }
  return "/";
}

/** Auth0 subjects are opaque, case-sensitive identifiers, never email aliases. */
export function normalizeAuth0Subject(value: unknown): string | null {
  if (typeof value !== "string" || !/^[ -~]+$/.test(value)) return null;
  const subject = value.trim();
  return /^[!-~]{1,255}$/.test(subject) ? subject : null;
}

export const finishAuth0Callback: NonNullable<Auth0ClientOptions["onCallback"]> = async (error, context, session) => {
  if (error || !normalizeAuth0Subject(session?.user?.sub)) return authFailure(400);
  const { appBaseUrl } = readAuth0Settings();
  // This returnTo comes from the SDK-verified transaction, not callback query input.
  return protectAuthResponse(NextResponse.redirect(new URL(validateReturnTo(context.returnTo, appBaseUrl), appBaseUrl)));
};

type Auth0Diagnostic = "AUTH0_TRANSPORT_FAILURE" | "AUTH0_HTTP_FAILURE" | "AUTH0_DISCOVERY_FAILURE";

function auth0Diagnostic(category: Auth0Diagnostic): Error {
  const error = new Error(category);
  // The SDK logs this value. Retain no upstream message, cause, response or stack.
  error.stack = category;
  return error;
}

async function readDiscoveryBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw auth0Diagnostic("AUTH0_DISCOVERY_FAILURE");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      // Match SDK 4.29.0's one-MiB response limit before buffering discovery.
      if (bytes > 1024 * 1024) throw auth0Diagnostic("AUTH0_DISCOVERY_FAILURE");
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function createAuth0Fetch(domain: string): typeof fetch {
  const upstreamFetch = globalThis.fetch;
  const issuer = new URL(`https://${domain}/`);
  const discoveryUrl = new URL(".well-known/openid-configuration", issuer).href;
  return async (input, init) => {
    let response: Response;
    try {
      response = await upstreamFetch(input, init);
    } catch {
      throw auth0Diagnostic("AUTH0_TRANSPORT_FAILURE");
    }
    // Task 1's discovery, token, JWKS and revocation responses require HTTP 200.
    // Never pass an error response (including its headers/body) to SDK loggers.
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw auth0Diagnostic("AUTH0_HTTP_FAILURE");
    }
    if ((input instanceof Request ? input.url : String(input)) !== discoveryUrl) return response;
    try {
      const body = await readDiscoveryBody(response);
      const metadata: unknown = JSON.parse(body);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("issuer" in metadata)
        || typeof metadata.issuer !== "string" || new URL(metadata.issuer).href !== issuer.href) {
        throw auth0Diagnostic("AUTH0_DISCOVERY_FAILURE");
      }
      // Re-emit the checked body so later stream failures cannot bypass this
      // boundary. The SDK still validates this unchanged metadata and all tokens.
      return new Response(body, { headers: { "content-type": "application/json" } });
    } catch {
      throw auth0Diagnostic("AUTH0_DISCOVERY_FAILURE");
    }
  };
}

// A route-specific callback hook lets Task 2 add post-login onboarding while
// retaining the SDK's state, nonce, PKCE, token verification and session handling.
export function createAuth0Client(options: Pick<Auth0ClientOptions, "onCallback"> = {}): Auth0Client {
  const settings = readAuth0Settings();
  return new Auth0Client({
    ...settings,
    customFetch: createAuth0Fetch(settings.domain),
    authorizationParameters: { scope: "openid profile email" },
    routes: { login: "/auth/login", logout: "/auth/logout", callback: "/auth/callback" },
    session: { rolling: false, cookie: { sameSite: "lax", path: "/" } },
    // Logout redirects must not serialize the session's ID token into a URL.
    includeIdTokenHintInOIDCLogoutUrl: false,
    enableAccessTokenEndpoint: false,
    enableConnectAccountEndpoint: false,
    onCallback: options.onCallback ?? finishAuth0Callback,
  });
}

// Defer construction until use so an unconfigured optional integration cannot
// break imports/builds. Binding SDK methods preserves its private instance state.
let client: Auth0Client | undefined;
export const auth0: Auth0Client = new Proxy({} as Auth0Client, {
  get(_target, property) {
    client ??= createAuth0Client();
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export async function getVerifiedAuth0Subject(): Promise<string | null> {
  try {
    return normalizeAuth0Subject((await auth0.getSession())?.user?.sub);
  } catch {
    return null;
  }
}

function authFailure(status: number): NextResponse {
  return protectAuthResponse(new NextResponse(unavailableMessage, { status }));
}

function protectAuthResponse(response: NextResponse): NextResponse {
  if (response.status >= 400) {
    // Retain transaction/session cookie deletion even when redacting SDK errors.
    response = new NextResponse(unavailableMessage, { status: response.status, headers: response.headers });
    response.headers.delete("content-length");
    response.headers.delete("location");
    response.headers.set("content-type", "text/plain; charset=utf-8");
  }
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

export async function handleAuthRoute(request: Request, route: "login" | "signup" | "logout" | "callback"): Promise<NextResponse> {
  try {
    const { appBaseUrl } = readAuth0Settings();
    const incoming = new URL(request.url);
    const returnTo = validateReturnTo(incoming.searchParams.get("returnTo"), appBaseUrl);
    if (route === "login" || route === "signup") {
      return protectAuthResponse(await auth0.startInteractiveLogin({
        returnTo,
        ...(route === "signup" ? { authorizationParameters: { screen_hint: "signup" } } : {}),
      }));
    }
    const url = new URL(`/auth/${route}`, appBaseUrl);
    if (route === "logout") {
      // The SDK's logout handler expects an absolute URL and does not sanitize it.
      url.searchParams.set("returnTo", new URL(returnTo, appBaseUrl).href);
    } else {
      url.search = incoming.search;
      url.searchParams.delete("returnTo");
    }
    return protectAuthResponse(await auth0.middleware(new Request(url, { headers: request.headers })));
  } catch {
    return authFailure(503);
  }
}
