import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const name = `signal-migration-${randomUUID()}`;
function docker(args, input) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000 });
  if (result.status !== 0) throw new Error(`migration_check_${args[0]}_failed: ${result.stderr?.slice(0, 500) ?? "unavailable"}`);
  return result.stdout.trim();
}
let created = false;
try {
  docker(["run", "--detach", "--rm", "--name", name, "--network", "none", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:18"]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { stdio: "ignore", timeout: 5_000 }).status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("migration_check_database_not_ready");
  const journal = JSON.parse(readFileSync(new URL("../src/db/migrations/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`../src/db/migrations/${entry.tag}.sql`, import.meta.url), "utf8");
    docker(["exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], `BEGIN;\n${sql}\nCOMMIT;`);
  }
  const verified = docker(["exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"], "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name IN ('execution_owner_run_id','execution_fencing_token','execution_lease_expires_at','retry_generation','next_attempt_at','dispatched_at','last_error_code');");
  if (verified !== "7") throw new Error("migration_check_missing_lifecycle_columns");
  console.log(`PASS: ${journal.entries.length} migrations applied transactionally to isolated PostgreSQL 18; outbox lifecycle columns verified.`);
} catch (error) {
  console.error(error instanceof Error && /^migration_check_/.test(error.message) ? error.message : "migration_check_failed");
  process.exitCode = 1;
} finally {
  if (created) {
    docker(["rm", "--force", name]);
    console.log("Removed the disposable migration-test container; no application data was used.");
  }
}
