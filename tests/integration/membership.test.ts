import assert, { AssertionError } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as nodeModule from "node:module";
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import * as tables from "../../src/db/schema";

// Match the required Node 24 runtime without changing pinned Node 20 types.
type Resolve = (specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => ResolveFnOutput) => ResolveFnOutput;
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export {};", shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

// Use the isolated integration runner, never application tables. Missing access
// is a skip, not a successful database test or a reason to use fake persistence.
if (!process.env.DATABASE_URL) {
  test("Task 2 membership integration", { skip: "NOT RUN: DATABASE_URL is absent" }, () => {});
} else {
  const scopedUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  let namespace: string | undefined;
  try { namespace = new URL(scopedUrl).searchParams.get("options")?.match(/^-c search_path=(signal_test_[a-f0-9]{32})$/)?.[1]; }
  catch { throw new Error("Task 2 integration configuration is invalid"); }
  if (!namespace) throw new Error("Task 2 requires the isolated integration runner");
  const { db, pool } = createDb(scopedUrl);
  const { createTenantForSubject, findMembershipBySubject } = await import("../../src/db/membership-repository");
  const { tenants, tenantMemberships } = tables;
  before(async () => {
    try {
      const result = await db.execute<{ namespace: string }>(sql`select current_schema() as namespace`);
      assert.equal(result.rows[0]?.namespace, namespace);
    } catch { throw new Error("Task 2 fixture isolation verification failed"); }
  });
  after(async () => {
    try { await pool.end(); } catch { throw new Error("Task 2 fixture cleanup failed safely"); }
  });

  function membershipTest(name: string, work: () => Promise<void>) {
    test(`Task 2 ${name}`, { timeout: 30_000 }, async () => {
      try { await work(); } catch (error) {
        if (error instanceof AssertionError) throw error;
        // Driver errors can contain SQL parameters and credentials.
        throw new Error("Task 2 synthetic membership check failed safely");
      }
    });
  }

  membershipTest("first signup creates an opaque tenant and matching OWNER without Slack or email", async () => {
    const subject = `auth0|${randomUUID()}`;
    const created = await createTenantForSubject(db, { subject, tenantName: "  " });
    assert.match(created.tenantId, /^[a-f0-9-]{36}$/);
    assert.equal(created.role, "OWNER");
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, created.tenantId));
    assert.equal(tenant.displayName, "My workspace");
    assert.equal(tenant.slackTeamId, null);
    assert.deepEqual(await findMembershipBySubject(db, `  ${subject}  `), {
      subject, tenantId: created.tenantId, role: "OWNER", active: true, tenantActive: true,
    });
  });

  membershipTest("concurrent and repeated signup returns one tenant without renaming it", async () => {
    const subject = `auth0|${randomUUID()}`;
    const input = { subject, tenantName: `Workspace ${randomUUID()}` };
    const results = await Promise.all(Array.from({ length: 4 }, () => createTenantForSubject(db, input)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual(await createTenantForSubject(db, { subject: ` ${subject} `, tenantName: "Changed" }), results[0]);
    const rows = await db.select().from(tenantMemberships).where(eq(tenantMemberships.auth0Subject, subject));
    assert.equal(rows.length, 1);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, results[0].tenantId));
    assert.equal(tenant.displayName, input.tenantName);
    assert.equal(await db.$count(tenants, eq(tenants.displayName, input.tenantName)), 1);
  });

  for (const inactive of ["membership", "tenant"] as const) {
    membershipTest(`inactive ${inactive} cannot gain a replacement tenant`, async () => {
      const subject = `auth0|${randomUUID()}`;
      const created = await createTenantForSubject(db, { subject, tenantName: "Inactive" });
      if (inactive === "membership") {
        await db.update(tenantMemberships).set({ active: false }).where(and(eq(tenantMemberships.tenantId, created.tenantId), eq(tenantMemberships.auth0Subject, subject)));
      } else await db.update(tenants).set({ active: false }).where(eq(tenants.id, created.tenantId));
      const membership = await findMembershipBySubject(db, subject);
      assert.equal(membership?.active, inactive !== "membership");
      assert.equal(membership?.tenantActive, inactive !== "tenant");
      await assert.rejects(createTenantForSubject(db, { subject, tenantName: "Bypass" }), /^Error: Tenant setup is unavailable\.$/);
      assert.equal((await db.select().from(tenantMemberships).where(eq(tenantMemberships.auth0Subject, subject))).length, 1);
    });
  }

  membershipTest("subject lookup cannot select another tenant and ambiguity denies signup", async () => {
    const firstSubject = `auth0|${randomUUID()}`;
    const otherSubject = `auth0|${randomUUID()}`;
    const first = await createTenantForSubject(db, { subject: firstSubject, tenantName: "First" });
    const other = await createTenantForSubject(db, { subject: otherSubject, tenantName: "Other" });
    await db.update(tenants).set({ active: false }).where(eq(tenants.id, other.tenantId));
    assert.equal((await findMembershipBySubject(db, firstSubject))?.tenantId, first.tenantId);
    assert.equal((await findMembershipBySubject(db, firstSubject))?.tenantActive, true);
    assert.equal(await findMembershipBySubject(db, `missing|${randomUUID()}`), null);
    await db.insert(tenantMemberships).values({ tenantId: other.tenantId, id: randomUUID(), auth0Subject: firstSubject, role: "MEMBER", active: false });
    assert.equal(await findMembershipBySubject(db, firstSubject), null);
    await assert.rejects(createTenantForSubject(db, { subject: firstSubject, tenantName: "Bypass" }));
  });

  membershipTest("membership constraint failure rolls back the tenant insert", async () => {
    const subject = `auth0|${randomUUID()}`;
    const tenantName = `Rollback ${randomUUID()}`;
    // This constraint is installed only in the checked disposable schema and
    // targets one synthetic subject. It forces failure after the tenant insert.
    await db.execute(sql`alter table ${tenantMemberships} add constraint task2_force_rollback check (auth0_subject <> ${sql.raw(`'${subject}'`)})`);
    try {
      await assert.rejects(createTenantForSubject(db, { subject, tenantName }), /^Error: Tenant setup is unavailable\.$/);
      assert.equal(await db.$count(tenants, eq(tenants.displayName, tenantName)), 0);
      assert.equal(await findMembershipBySubject(db, subject), null);
    } finally {
      await db.execute(sql`alter table ${tenantMemberships} drop constraint task2_force_rollback`);
    }
  });

  membershipTest("database keys reject orphan, duplicate, malformed-subject and invalid-role memberships", async () => {
    const subject = `auth0|${randomUUID()}`;
    const created = await createTenantForSubject(db, { subject, tenantName: "Constraints" });
    const base = { tenantId: created.tenantId, id: randomUUID(), auth0Subject: subject, role: "OWNER" as const };
    await assert.rejects(db.insert(tenantMemberships).values(base));
    await assert.rejects(db.insert(tenantMemberships).values({ ...base, tenantId: randomUUID() }));
    await assert.rejects(db.insert(tenantMemberships).values({ ...base, auth0Subject: " padded " }));
    await assert.rejects(db.execute(sql`insert into ${tenantMemberships} (tenant_id, id, auth0_subject, role) values (${created.tenantId}, ${randomUUID()}, ${`auth0|${randomUUID()}`}, 'SUPERADMIN')`));
  });

  for (const role of ["ADMIN", "MEMBER"] as const) {
    membershipTest(`existing ${role} cannot promote itself through onboarding`, async () => {
      const subject = `auth0|${randomUUID()}`;
      const created = await createTenantForSubject(db, { subject, tenantName: "Existing" });
      await db.update(tenantMemberships).set({ role }).where(and(eq(tenantMemberships.tenantId, created.tenantId), eq(tenantMemberships.auth0Subject, subject)));
      await assert.rejects(createTenantForSubject(db, { subject, tenantName: "Escalation" }));
      assert.equal((await findMembershipBySubject(db, subject))?.role, role);
    });
  }
}
