import "server-only";
import { createDb, type SignalDb } from "../db/client";
import { findMembershipBySubject } from "../db/membership-repository";
import { auth0, normalizeAuth0Subject } from "./auth0";

export type ViewerTenant = { subject: string; tenantId: string; role: "OWNER" | "ADMIN" | "MEMBER" };
export type Membership = ViewerTenant & { active: boolean; tenantActive: boolean };

export interface MembershipRepository {
  // Task 2 must join the membership to its tenant, return both active flags, and
  // return null for ambiguous subjects. No LIMIT 1 across multiple memberships.
  findMembershipBySubject(db: SignalDb, subject: string): Promise<Membership | null>;
}

type Connection = { db: SignalDb; pool: { end(): Promise<void> } };
export interface ViewerTenantDependencies {
  getSession(): Promise<unknown>;
  createDb(): Connection;
  findMembershipBySubject?: MembershipRepository["findMembershipBySubject"];
}

/** Server composition/test seam only. This is not a Server Action or HTTP API. */
export function createViewerTenantResolver(dependencies: ViewerTenantDependencies): () => Promise<ViewerTenant | null> {
  return async () => {
    let connection: Connection | undefined;
    try {
      const session = await dependencies.getSession();
      if (!session || typeof session !== "object" || !("user" in session)) return null;
      const user = session.user;
      const subject = normalizeAuth0Subject(user && typeof user === "object" && "sub" in user ? user.sub : null);
      if (!subject || !dependencies.findMembershipBySubject) return null;
      connection = dependencies.createDb();
      const membership = await dependencies.findMembershipBySubject(connection.db, subject);
      if (!membership || membership.subject !== subject || membership.active !== true || membership.tenantActive !== true
        || typeof membership.tenantId !== "string" || !/^[!-~]{1,255}$/.test(membership.tenantId)
        || !["OWNER", "ADMIN", "MEMBER"].includes(membership.role)) return null;
      return { subject, tenantId: membership.tenantId, role: membership.role };
    } catch {
      return null;
    } finally {
      try {
        await connection?.pool.end();
      } catch {
        // Connection/session details must never replace the sanitized result.
      }
    }
  };
}

export const resolveViewerTenant = createViewerTenantResolver({
  getSession: () => auth0.getSession(),
  createDb,
  findMembershipBySubject,
});
