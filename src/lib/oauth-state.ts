import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createDb, type SignalDb } from "../db/client";
import { readOAuthState, storeOAuthState, takeOAuthState, type ConnectionProvider, type NewOAuthState, type OAuthStateQuery, type OAuthStateRecord, type OAuthStateSealer, type ProviderConnectionCompletion } from "../db/connection-repository";
import { requireTenantAdmin } from "../db/membership-repository";
import { validateReturnTo } from "./auth0";
import { openConnectionSecret, sealConnectionSecret } from "./connection-crypto";
import { resolveViewerTenant, type ViewerTenant } from "./tenant-context";

type CreateInput = { tenantId: string; subject: string; provider: ConnectionProvider; returnTo: string };
type CallbackInput = { subject: string; provider: ConnectionProvider };
// Server-only callback material: forward completion unchanged to upsert and
// never serialize completion, nonce or verifier into a browser response.
type ConsumedState = { tenantId: string; returnTo: string; nonce: string; pkceVerifier: string | null; completion: ProviderConnectionCompletion };
export interface OAuthStateStore {
  save(record: NewOAuthState, sealPayload: OAuthStateSealer): Promise<void>;
  read(query: OAuthStateQuery): Promise<OAuthStateRecord | null>;
  consume(query: OAuthStateQuery): Promise<OAuthStateRecord | null>;
}
interface OAuthStateDependencies {
  store: OAuthStateStore;
  resolveViewerTenant(): Promise<ViewerTenant | null>;
  getEncryptionKey(): string;
  now?: () => Date;
}

const unavailable = "OAuth state is unavailable.";
const localOrigin = "https://signal.invalid";
const validProvider = (value: unknown): value is ConnectionProvider => value === "github" || value === "slack";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const validToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;

function returnPath(value: unknown): string {
  if (typeof value !== "string" || validateReturnTo(value, localOrigin) !== value) throw new Error();
  return value;
}

/** Server composition/test seam. The store must also recheck persisted admin
 * membership atomically with the write, as the default PostgreSQL store does. */
export function createOAuthStateService(dependencies: OAuthStateDependencies) {
  const now = dependencies.now ?? (() => new Date());

  async function authority(input: CallbackInput): Promise<ViewerTenant> {
    const viewer = await dependencies.resolveViewerTenant();
    requireTenantAdmin(viewer);
    if (!viewer || !input || input.subject !== viewer.subject || !validProvider(input.provider)) throw new Error();
    return viewer;
  }

  async function load(state: string, input: CallbackInput, consume: boolean): Promise<ConsumedState> {
    const viewer = await authority(input);
    if (!validToken(state)) throw new Error();
    const query = { tenantId: viewer.tenantId, subject: viewer.subject, provider: input.provider, stateHash: digest(state) };
    // Consume before decrypting: a bad key or envelope never makes this token
    // reusable. The store commits the one-way transition independently.
    const row = await (consume ? dependencies.store.consume(query) : dependencies.store.read(query));
    if (!row || (!consume && row.consumedAt) || row.tenantId !== viewer.tenantId || row.subject !== viewer.subject
      || row.provider !== input.provider || row.stateHash !== query.stateHash || !(row.expiresAt instanceof Date)
      || !Number.isFinite(row.expiresAt.getTime()) || row.expiresAt.getTime() <= now().getTime()) throw new Error();
    const payload: unknown = JSON.parse(openConnectionSecret(row.encryptedPayload, dependencies.getEncryptionKey()));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    const bound = payload as Record<string, unknown>;
    if (bound.version !== 1 || bound.tenantId !== row.tenantId || bound.subject !== row.subject || bound.provider !== row.provider
      || bound.stateHash !== row.stateHash || bound.returnTo !== row.returnTo || bound.expiresAt !== row.expiresAt.toISOString()
      || typeof bound.generation !== "number" || !Number.isSafeInteger(bound.generation) || bound.generation < 1
      || !validToken(bound.nonce) || (row.provider === "slack" ? !validToken(bound.pkceVerifier) : bound.pkceVerifier !== null)) throw new Error();
    return {
      tenantId: viewer.tenantId, returnTo: returnPath(row.returnTo), nonce: bound.nonce, pkceVerifier: bound.pkceVerifier as string | null,
      completion: { ...query, generation: bound.generation },
    };
  }

  return {
    async createOAuthState(input: CreateInput): Promise<string> {
      try {
        const viewer = await authority(input);
        if (input.tenantId !== viewer.tenantId) throw new Error();
        const returnTo = returnPath(input.returnTo);
        const state = randomToken();
        const stateHash = digest(state);
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + 600_000);
        const payload = {
          version: 1, stateHash, tenantId: viewer.tenantId, subject: viewer.subject, provider: input.provider, returnTo,
          expiresAt: expiresAt.toISOString(), nonce: randomToken(), pkceVerifier: input.provider === "slack" ? randomToken() : null,
        };
        await dependencies.store.save(
          { tenantId: viewer.tenantId, subject: viewer.subject, provider: input.provider, stateHash, returnTo, createdAt, expiresAt },
          (generation) => sealConnectionSecret(JSON.stringify({ ...payload, generation }), dependencies.getEncryptionKey()),
        );
        return state;
      } catch { throw new Error(unavailable); }
    },

    async consumeOAuthState(state: string, input: CallbackInput): Promise<ConsumedState> {
      try { return await load(state, input, true); }
      catch { throw new Error(unavailable); }
    },

    /** Start-route helper: reveals only nonce and the S256 challenge, never the
     * verifier. GitHub App installation has no personal OAuth/PKCE exchange. */
    async getOAuthStateAuthorization(state: string, input: CallbackInput): Promise<{ nonce: string; codeChallenge: string | null; codeChallengeMethod: "S256" | null }> {
      try {
        const verified = await load(state, input, false);
        return {
          nonce: verified.nonce,
          codeChallenge: verified.pkceVerifier ? createHash("sha256").update(verified.pkceVerifier).digest("base64url") : null,
          codeChallengeMethod: verified.pkceVerifier ? "S256" : null,
        };
      } catch { throw new Error(unavailable); }
    },
  };
}

async function withDatabase<T>(work: (db: SignalDb) => Promise<T>): Promise<T> {
  let connection: ReturnType<typeof createDb> | undefined;
  try {
    connection = createDb();
    return await work(connection.db);
  } finally {
    // A failed pool cleanup must not replace a committed consume result or leak
    // its underlying connection details. Repository/service errors are sanitized.
    try { await connection?.pool.end(); } catch { /* No sensitive diagnostics. */ }
  }
}

export const { createOAuthState, consumeOAuthState, getOAuthStateAuthorization } = createOAuthStateService({
  resolveViewerTenant, getEncryptionKey: () => process.env.CONNECTIONS_ENCRYPTION_KEY ?? "",
  store: {
    save: (row, sealPayload) => withDatabase((db) => storeOAuthState(db, row, sealPayload)),
    read: (query) => withDatabase((db) => readOAuthState(db, query)),
    consume: (query) => withDatabase((db) => takeOAuthState(db, query)),
  },
});
