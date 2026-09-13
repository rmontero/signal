"use server";

import { redirect } from "next/navigation.js";
import { createDb } from "../../db/client";
import { createTenantForSubject } from "../../db/membership-repository";
import { getVerifiedAuth0Subject } from "../../lib/auth0";

export async function createWorkspace(formData: FormData): Promise<void> {
  const subject = await getVerifiedAuth0Subject();
  if (!subject) redirect("/auth/login?returnTo=%2Fonboarding");
  let connection: ReturnType<typeof createDb> | undefined;
  let destination = "/";
  try {
    // Read only a display name from the form. Subject, tenant, role and returnTo
    // fields cannot choose identity, permissions or the post-action destination.
    const tenantName = formData.get("tenantName") ?? "";
    if (typeof tenantName !== "string") throw new Error();
    connection = createDb();
    await createTenantForSubject(connection.db, { subject, tenantName });
  } catch {
    destination = "/onboarding?error=unavailable";
  } finally {
    try { await connection?.pool.end(); } catch { /* Do not replace the safe result. */ }
  }
  // Next's redirect throws; it must stay outside the persistence catch block.
  redirect(destination);
}
