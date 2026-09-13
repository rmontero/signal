import { redirect } from "next/navigation.js";
import { createDb } from "../../db/client";
import { findMembershipBySubject } from "../../db/membership-repository";
import { getVerifiedAuth0Subject } from "../../lib/auth0";
import { createWorkspace } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const subject = await getVerifiedAuth0Subject();
  if (!subject) redirect("/auth/login?returnTo=%2Fonboarding");
  let connection: ReturnType<typeof createDb> | undefined;
  let existing = false;
  let unavailable = false;
  try {
    connection = createDb();
    const membership = await findMembershipBySubject(connection.db, subject);
    existing = !!membership?.active && !!membership.tenantActive;
    unavailable = !!membership && !existing;
  } catch {
    unavailable = true;
  } finally {
    try { await connection?.pool.end(); } catch { /* Connection errors are private. */ }
  }
  if (existing) redirect("/");
  const failed = (await searchParams).error === "unavailable";

  return (
    <main style={{ maxWidth: 480, margin: "12vh auto", padding: 32, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 16 }}>
      <p style={{ color: "var(--teal)", fontWeight: 700 }}>Signal</p>
      <h1>Create your workspace</h1>
      <p>Give your team a place to turn conversations into action.</p>
      {(unavailable || failed) && <p role="alert">We couldn’t set up your workspace. Try again or contact your workspace administrator.</p>}
      {!unavailable && (
        <form action={createWorkspace}>
          <label htmlFor="tenantName">Workspace name</label>
          <input id="tenantName" name="tenantName" type="text" maxLength={120} placeholder="My workspace" autoComplete="organization"
            style={{ display: "block", width: "100%", margin: "8px 0 20px", padding: 12, border: "1px solid var(--line-strong)", borderRadius: 8 }} />
          <button type="submit" style={{ padding: "12px 18px", background: "var(--teal-dark)", color: "white", borderRadius: 8, cursor: "pointer" }}>Create workspace</button>
        </form>
      )}
      <p><a href="/auth/logout" style={{ textDecoration: "underline" }}>Sign out</a></p>
    </main>
  );
}
