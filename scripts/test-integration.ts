import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Pool } from "@neondatabase/serverless";

const baseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error("integration_database_not_configured");
const namespace = `signal_test_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: baseUrl });
let created = false;
let isolated: Pool | undefined;
try {
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  created = true;
  const scopedUrl = new URL(baseUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${namespace}`);
  isolated = new Pool({ connectionString: scopedUrl.toString() });
  const check = await isolated.query<{ namespace: string }>("SELECT current_schema() AS namespace");
  if (check.rows[0]?.namespace !== namespace) throw new Error("integration_isolation_not_established");
  const journal = JSON.parse(await readFile(new URL("../src/db/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string }> };
  const client = await isolated.connect();
  try {
    await client.query("BEGIN");
    for (const migration of journal.entries) {
      const ddl = await readFile(new URL(`../src/db/migrations/${migration.tag}.sql`, import.meta.url), "utf8");
      await client.query(ddl.replaceAll('"public".', `"${namespace}".`));
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
    throw new Error("integration_migration_failed");
  } finally { client.release(); }
  console.log("Integration isolation verified; migrations applied only to the disposable schema.");
  const tests = (await readdir(new URL("../tests/integration/", import.meta.url))).filter((name) => name.endsWith(".test.ts")).map((name) => `tests/integration/${name}`);
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--test", ...process.argv.slice(2), ...tests], {
      stdio: "inherit", env: { ...process.env, DATABASE_URL: scopedUrl.toString(), DATABASE_URL_UNPOOLED: scopedUrl.toString() },
    });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} catch {
  console.error("Integration setup failed safely; no production-table migrations were applied.");
  process.exitCode = 1;
} finally {
  await isolated?.end();
  if (created && /^signal_test_[a-f0-9]{32}$/.test(namespace)) {
    await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
    console.log("Removed the disposable integration-test schema and its synthetic fixtures.");
  }
  await admin.end();
}
