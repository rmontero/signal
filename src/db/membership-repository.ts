import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { normalizeAuth0Subject } from "../lib/auth0";
import type { Membership, ViewerTenant } from "../lib/tenant-context";
import type { SignalDb } from "./client";
import { tenantMemberships, tenants } from "./schema";

type Transaction = Parameters<Parameters<SignalDb["transaction"]>[0]>[0];

function subjectMemberships(db: SignalDb | Transaction, subject: string) {
  // Keep inactive rows in this lookup: hiding them would turn revocation or an
  // ambiguous identity into permission to create another tenant on signup.
  return db.select({
    subject: tenantMemberships.auth0Subject, tenantId: tenantMemberships.tenantId,
    role: tenantMemberships.role, active: tenantMemberships.active, tenantActive: tenants.active,
  }).from(tenantMemberships).innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
    .where(eq(tenantMemberships.auth0Subject, subject)).limit(2);
}

function matchesSubject(membership: Membership, subject: string): boolean {
  return membership.subject === subject && /^[!-~]{1,255}$/.test(membership.tenantId)
    && ["OWNER", "ADMIN", "MEMBER"].includes(membership.role);
}

/** Bootstrap identity lookup; callers never supply a tenant selector. */
export async function findMembershipBySubject(db: SignalDb, input: string): Promise<Membership | null> {
  const subject = normalizeAuth0Subject(input);
  if (!subject) return null;
  try {
    const rows = await subjectMemberships(db, subject);
    return rows.length === 1 && matchesSubject(rows[0], subject) ? rows[0] : null;
  } catch {
    // Drizzle exceptions include query parameters. Keep them inside the DAL.
    throw new Error("Tenant membership is unavailable.");
  }
}

/** Requires server-resolved authority; this helper is not a Server Action. */
export function requireTenantAdmin(viewer: ViewerTenant | null): void {
  if (!viewer || !normalizeAuth0Subject(viewer.subject) || normalizeAuth0Subject(viewer.subject) !== viewer.subject
    || typeof viewer.tenantId !== "string" || !/^[!-~]{1,255}$/.test(viewer.tenantId)
    || !["OWNER", "ADMIN"].includes(viewer.role)) throw new Error("Tenant administration is unavailable.");
}

export async function createTenantForSubject(db: SignalDb, input: { subject: string; tenantName: string }): Promise<{ tenantId: string; role: "OWNER" }> {
  try {
    const subject = normalizeAuth0Subject(input.subject);
    if (!subject || typeof input.tenantName !== "string" || input.tenantName.length > 120
      || [...input.tenantName].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error();
    const displayName = input.tenantName.trim() || "My workspace";
    return await db.transaction(async (tx) => {
      // A row lock cannot lock an absent membership. Serialize the bootstrap by
      // the normalized opaque subject, then re-read after acquiring the lock.
      // Hash collisions only serialize unrelated signups; they cannot grant access.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`signal:onboarding:${subject}`}, 0))`);
      const rows = await subjectMemberships(tx, subject).for("update");
      if (rows.length) {
        const membership = rows[0];
        if (rows.length !== 1 || !matchesSubject(membership, subject) || !membership.active || !membership.tenantActive) throw new Error();
        requireTenantAdmin(membership);
        // A repeat signup cannot elevate an existing ADMIN or MEMBER to OWNER.
        if (membership.role !== "OWNER") throw new Error();
        return { tenantId: membership.tenantId, role: "OWNER" };
      }
      const tenantId = randomUUID();
      await tx.insert(tenants).values({ id: tenantId, displayName });
      await tx.insert(tenantMemberships).values({ tenantId, id: randomUUID(), auth0Subject: subject, role: "OWNER" });
      return { tenantId, role: "OWNER" };
    }, { isolationLevel: "read committed" });
  } catch {
    throw new Error("Tenant setup is unavailable.");
  }
}
