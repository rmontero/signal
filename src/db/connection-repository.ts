import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { validateReturnTo } from "../lib/auth0";
import { openConnectionSecret } from "../lib/connection-crypto";
import { resolveViewerTenant, type ViewerTenant } from "../lib/tenant-context";
import type { SignalDb } from "./client";
import { requireTenantAdmin } from "./membership-repository";
import { audit, channelMappings, oauthStates, providerConnections, tenantMemberships, tenants } from "./schema";

type Transaction = Parameters<Parameters<SignalDb["transaction"]>[0]>[0];
export type ConnectionProvider = "github" | "slack";
export type OAuthStateRecord = typeof oauthStates.$inferSelect;
export type NewOAuthState = Omit<OAuthStateRecord, "consumedAt">;
export type OAuthStateQuery = Pick<OAuthStateRecord, "tenantId" | "subject" | "provider" | "stateHash">;
type Connection = typeof providerConnections.$inferSelect;
export type SafeConnectionSummary = Pick<Connection, "provider" | "externalAccountId" | "installationId" | "botUserId" | "displayName" | "scopes" | "status" | "createdAt" | "updatedAt" | "revokedAt"> & { connectionId: string };
type ConnectionInput = { externalAccountId: string; displayName: string; scopes: string[] } & (
  | { provider: "github"; installationId: string; encryptedSecret?: never; botUserId?: never }
  | { provider: "slack"; botUserId: string; encryptedSecret: string; installationId?: never }
);

export interface ConnectionRepositoryDependencies {
  resolveViewerTenant(): Promise<ViewerTenant | null>;
  getEncryptionKey(): string;
}

const unavailable = "Provider connection is unavailable.";
const localOrigin = "https://signal.invalid";
const validId = (value: unknown): value is string => typeof value === "string" && /^[!-~]{1,255}$/.test(value);
const validProvider = (value: unknown): value is ConnectionProvider => value === "github" || value === "slack";

function summary(row: Connection): SafeConnectionSummary {
  // Explicit allowlist: never return an ORM row or encrypted credentials.
  return {
    connectionId: row.id, provider: row.provider, externalAccountId: row.externalAccountId,
    installationId: row.installationId, botUserId: row.botUserId, displayName: row.displayName,
    scopes: row.scopes, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, revokedAt: row.revokedAt,
  };
}

function connectionValues(input: ConnectionInput, getKey: () => string) {
  if (!input || !validProvider(input.provider) || !validId(input.externalAccountId)
    || typeof input.displayName !== "string" || input.displayName !== input.displayName.trim() || input.displayName.length < 1 || input.displayName.length > 120
    || [...input.displayName].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    || !Array.isArray(input.scopes) || input.scopes.length > 100 || !input.scopes.every(validId)) throw new Error();
  const common = { provider: input.provider, externalAccountId: input.externalAccountId, displayName: input.displayName, scopes: [...new Set(input.scopes)].sort() };
  if (input.provider === "github") {
    if (!validId(input.installationId) || input.encryptedSecret !== undefined || input.botUserId !== undefined) throw new Error();
    return { ...common, installationId: input.installationId, botUserId: null, encryptedSecret: null };
  }
  if (!validId(input.botUserId) || input.installationId !== undefined || typeof input.encryptedSecret !== "string"
    || !openConnectionSecret(input.encryptedSecret, getKey())) throw new Error();
  return { ...common, installationId: null, botUserId: input.botUserId, encryptedSecret: input.encryptedSecret };
}

async function disableMappings(tx: Transaction, tenantId: string) {
  // One GitHub/Slack connection per tenant: every channel depends on both.
  return tx.update(channelMappings).set({ enabled: false })
    .where(and(eq(channelMappings.tenantId, tenantId), eq(channelMappings.enabled, true))).returning({ channelId: channelMappings.channelId });
}

async function invalidateConfiguration(tx: Transaction, tenantId: string) {
  await tx.update(tenants).set({ configVersion: sql`${tenants.configVersion} + 1` }).where(eq(tenants.id, tenantId));
}

/** Server composition seam, never a Server Action. Production exports resolve
 * their own server session; mutation inputs contain no tenant, role or subject. */
export function createConnectionRepository(dependencies: ConnectionRepositoryDependencies) {
  async function asAdmin<T>(db: SignalDb, work: (tx: Transaction, viewer: ViewerTenant) => Promise<T>): Promise<T> {
    try {
      const viewer = await dependencies.resolveViewerTenant();
      requireTenantAdmin(viewer);
      if (!viewer) throw new Error();
      return await db.transaction(async (tx) => {
        // Re-read persisted authority under locks. Include inactive/ambiguous
        // memberships, as in the existing subject bootstrap repository.
        const rows = await tx.select({
          subject: tenantMemberships.auth0Subject, tenantId: tenantMemberships.tenantId,
          role: tenantMemberships.role, active: tenantMemberships.active, tenantActive: tenants.active,
        }).from(tenantMemberships).innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
          .where(eq(tenantMemberships.auth0Subject, viewer.subject)).limit(2).for("update");
        const member = rows[0];
        if (rows.length !== 1 || member.subject !== viewer.subject || member.tenantId !== viewer.tenantId
          || member.active !== true || member.tenantActive !== true) throw new Error();
        requireTenantAdmin(member);
        return work(tx, member);
      }, { isolationLevel: "read committed" });
    } catch {
      // In particular, do not propagate Drizzle errors (SQL + secret parameters).
      throw new Error(unavailable);
    }
  }

  function checkStateQuery(input: OAuthStateQuery, viewer: ViewerTenant) {
    if (!input || input.tenantId !== viewer.tenantId || input.subject !== viewer.subject
      || !validProvider(input.provider) || typeof input.stateHash !== "string" || !/^[a-f0-9]{64}$/.test(input.stateHash)) throw new Error();
  }

  function statePredicate(input: OAuthStateQuery) {
    return and(eq(oauthStates.tenantId, input.tenantId), eq(oauthStates.stateHash, input.stateHash),
      eq(oauthStates.subject, input.subject), eq(oauthStates.provider, input.provider), isNull(oauthStates.consumedAt),
      sql`${oauthStates.expiresAt} > clock_timestamp()`);
  }

  return {
    async upsertProviderConnection(db: SignalDb, input: ConnectionInput): Promise<SafeConnectionSummary> {
      return asAdmin(db, async (tx, viewer) => {
        const values = connectionValues(input, dependencies.getEncryptionKey);
        const [previous] = await tx.select().from(providerConnections)
          .where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, input.provider)));
        const [row] = await tx.insert(providerConnections).values({
          ...values, tenantId: viewer.tenantId, id: randomUUID(), connectedBySubject: viewer.subject,
        }).onConflictDoUpdate({ target: [providerConnections.tenantId, providerConnections.provider], set: {
          ...values, connectedBySubject: viewer.subject, status: "ACTIVE", revokedAt: null, updatedAt: sql`clock_timestamp()`,
        } }).returning();
        if (!row) throw new Error();
        // A different installation/workspace cannot inherit old channel authority.
        // Reconnecting never enables mappings; explicit configuration follows.
        if (!previous || previous.externalAccountId !== row.externalAccountId || previous.installationId !== row.installationId) await disableMappings(tx, viewer.tenantId);
        await invalidateConfiguration(tx, viewer.tenantId);
        await tx.insert(audit).values({ tenantId: viewer.tenantId, id: randomUUID(), entityType: "provider_connection", entityId: row.id, fromState: previous?.status ?? null, toState: "ACTIVE" });
        return summary(row);
      });
    },

    async revokeProviderConnection(db: SignalDb, input: { provider: ConnectionProvider }): Promise<SafeConnectionSummary> {
      return asAdmin(db, async (tx, viewer) => {
        if (!input || !validProvider(input.provider)) throw new Error();
        const [previous] = await tx.select().from(providerConnections)
          .where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.provider, input.provider)));
        if (!previous) throw new Error();
        const disabled = await disableMappings(tx, viewer.tenantId);
        // Burn outstanding unconsumed callbacks as part of disconnect.
        await tx.update(oauthStates).set({ consumedAt: sql`clock_timestamp()` }).where(and(
          eq(oauthStates.tenantId, viewer.tenantId), eq(oauthStates.provider, input.provider), isNull(oauthStates.consumedAt),
        ));
        if (previous.status === "REVOKED") {
          if (disabled.length) await invalidateConfiguration(tx, viewer.tenantId);
          return summary(previous);
        }
        const [row] = await tx.update(providerConnections).set({ status: "REVOKED", encryptedSecret: null, revokedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(providerConnections.tenantId, viewer.tenantId), eq(providerConnections.id, previous.id))).returning();
        if (!row) throw new Error();
        await invalidateConfiguration(tx, viewer.tenantId);
        await tx.insert(audit).values({ tenantId: viewer.tenantId, id: randomUUID(), entityType: "provider_connection", entityId: row.id, fromState: previous.status, toState: "REVOKED" });
        return summary(row);
      });
    },

    async storeOAuthState(db: SignalDb, input: NewOAuthState): Promise<void> {
      return asAdmin(db, async (tx, viewer) => {
        checkStateQuery(input, viewer);
        if (typeof input.returnTo !== "string" || validateReturnTo(input.returnTo, localOrigin) !== input.returnTo
          || !(input.createdAt instanceof Date) || !(input.expiresAt instanceof Date)
          || !Number.isFinite(input.createdAt.getTime()) || !Number.isFinite(input.expiresAt.getTime())
          || input.expiresAt.getTime() <= Date.now() || input.expiresAt.getTime() <= input.createdAt.getTime()
          || input.expiresAt.getTime() - input.createdAt.getTime() > 600_000
          || !openConnectionSecret(input.encryptedPayload, dependencies.getEncryptionKey())) throw new Error();
        await tx.insert(oauthStates).values({
          tenantId: viewer.tenantId, subject: viewer.subject, stateHash: input.stateHash, provider: input.provider,
          returnTo: input.returnTo, encryptedPayload: input.encryptedPayload, createdAt: input.createdAt, expiresAt: input.expiresAt,
        });
      });
    },

    async readOAuthState(db: SignalDb, input: OAuthStateQuery): Promise<OAuthStateRecord | null> {
      return asAdmin(db, async (tx, viewer) => {
        checkStateQuery(input, viewer);
        const [row] = await tx.select().from(oauthStates).where(statePredicate(input));
        return row ?? null;
      });
    },

    async takeOAuthState(db: SignalDb, input: OAuthStateQuery): Promise<OAuthStateRecord | null> {
      return asAdmin(db, async (tx, viewer) => {
        checkStateQuery(input, viewer);
        // One conditional UPDATE is the admission point. PostgreSQL rechecks
        // the predicate after a concurrent updater commits; only one returns a row.
        const [row] = await tx.update(oauthStates).set({ consumedAt: sql`clock_timestamp()` }).where(statePredicate(input)).returning();
        return row ?? null;
      });
    },
  };
}

export const { upsertProviderConnection, revokeProviderConnection, storeOAuthState, readOAuthState, takeOAuthState } = createConnectionRepository({
  resolveViewerTenant, getEncryptionKey: () => process.env.CONNECTIONS_ENCRYPTION_KEY ?? "",
});
