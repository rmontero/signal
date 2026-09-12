import assert from "node:assert/strict";
import test from "node:test";
import { GET as healthz } from "../../src/app/healthz/route";
import { GET as maintenance } from "../../src/app/api/internal/maintenance/route";

test("healthz exposes only public liveness", async () => {
  const response = healthz();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("maintenance rejects missing and incorrect bearer credentials", async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-maintenance-secret";
  try {
    assert.equal((await maintenance(new Request("http://localhost/api/internal/maintenance"))).status, 401);
    assert.equal((await maintenance(new Request("http://localhost/api/internal/maintenance", { headers: { authorization: "Bearer wrong" } }))).status, 401);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test("maintenance does not expose dependencies when runtime configuration is unavailable", async () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalDatabase = process.env.DATABASE_URL;
  process.env.CRON_SECRET = "test-maintenance-secret";
  delete process.env.DATABASE_URL;
  try {
    const response = await maintenance(new Request("http://localhost/api/internal/maintenance", { headers: { authorization: "Bearer test-maintenance-secret" } }));
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
  }
});
