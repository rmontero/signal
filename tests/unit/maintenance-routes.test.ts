import assert from "node:assert/strict";
import test from "node:test";
import { GET as healthz } from "../../src/app/healthz/route";
import { GET as maintenance } from "../../src/app/api/internal/maintenance/route";
import { createMaintenanceHandler, type MaintenanceDependencies } from "../../src/app/api/internal/maintenance/handler";
import type { Connection } from "../../src/app/api/_lib/ingress";

const secret = "synthetic-maintenance-secret";
const recoveryCounts = { inspected: 3, dispatched: 2, recoveryQueued: 1, retried: 1, settled: 1, blocked: 0 };

function fixture(overrides: Partial<MaintenanceDependencies> = {}) {
  let opened = 0;
  let closed = 0;
  const calls: string[] = [];
  const after: Array<() => Promise<void>> = [];
  const connection: Connection = { db: {} as Connection["db"], pool: { end: async () => { closed += 1; } } };
  const handler = createMaintenanceHandler({
    cronSecret: () => secret,
    createDb: () => { opened += 1; return connection; },
    cleanupRetention: async () => { calls.push("cleanup"); return { snapshots: 2, proposals: 1 }; },
    recoverOutbox: async () => { calls.push("recovery"); return recoveryCounts; },
    after: (work) => { after.push(work); },
    ...overrides,
  });
  return { handler, calls, connection, counts: () => ({ opened, closed }), flush: async () => { for (const work of after.splice(0)) await work(); } };
}

function request(authorization = `Bearer ${secret}`) {
  return new Request("http://localhost/api/internal/maintenance", { headers: { authorization } });
}

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

test("bearer authorization is exact, fails closed and never accesses persistence on failure", async () => {
  const subject = fixture();
  for (const authorization of ["", secret, `Basic ${secret}`, `Bearer\t${secret}`, "Bearer wrong", `Bearer ${secret.slice(0, -1)}`, `Bearer ${secret}x`, `Bearer ${secret},Bearer ${secret}`, `Bearer ${secret} extra`, `Bearers ${secret}`]) {
    const response = await subject.handler(request(authorization));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal(body.error.code, "unauthorized");
    assert.match(body.error.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.stringify(body).includes(secret), false);
  }
  assert.deepEqual(subject.counts(), { opened: 0, closed: 0 });
  assert.deepEqual(subject.calls, []);
  for (const expected of [undefined, "", " ", ` ${secret}`, `${secret} `]) {
    const unconfigured = fixture({ cronSecret: () => expected });
    assert.equal((await unconfigured.handler(request())).status, 401);
    assert.equal(unconfigured.counts().opened, 0);
  }
});

test("valid bearer runs shared services once and emits only counts", async () => {
  for (const authorization of [`Bearer ${secret}`, `bearer ${secret}`, `BEARER  ${secret}`]) {
    const subject = fixture();
    const response = await subject.handler(request(authorization));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", ...recoveryCounts, cleanup: { snapshots: 2, proposals: 1 } });
    assert.deepEqual(subject.calls, ["cleanup", "recovery"]);
    assert.deepEqual(subject.counts(), { opened: 1, closed: 0 });
    await subject.flush();
    assert.equal(subject.counts().closed, 1);
  }
});

test("maintenance never spreads unknown fields or malformed service counts into the response", async () => {
  const subject = fixture({
    cleanupRetention: async () => ({ snapshots: 2, proposals: 1, secret: "synthetic-secret-error" }),
    recoverOutbox: async () => ({ ...recoveryCounts, payload: "synthetic-secret-error" }),
  });
  const response = await subject.handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", ...recoveryCounts, cleanup: { snapshots: 2, proposals: 1 } });
  await subject.flush();
  for (const count of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = fixture({ recoverOutbox: async () => ({ ...recoveryCounts, inspected: count }) });
    assert.equal((await bad.handler(request())).status, 503);
    await bad.flush();
  }
});

test("maintenance setup, cleanup and recovery errors return sanitized failures", async () => {
  for (const stage of ["setup", "cleanup", "recovery"]) {
    const fail = async () => { throw new Error("synthetic-secret-error"); };
    const subject = fixture(stage === "setup" ? { createDb: () => { throw new Error("synthetic-secret-error"); } } : stage === "cleanup" ? { cleanupRetention: fail } : { recoverOutbox: fail });
    const response = await subject.handler(request());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "requestId"]);
    assert.equal(body.error.code, "maintenance_unavailable");
    assert.equal(JSON.stringify(body).includes("synthetic-secret-error"), false);
    if (stage === "cleanup") assert.equal(subject.calls.includes("recovery"), false);
    await subject.flush();
  }
});

test("slow cleanup gets a bounded 503 and never starts recovery after timeout", async () => {
  let resolve!: (value: { snapshots: number; proposals: number }) => void;
  const pending = new Promise<{ snapshots: number; proposals: number }>((done) => { resolve = done; });
  const subject = fixture({ timeoutMs: 15, cleanupRetention: () => pending });
  const response = await subject.handler(request());
  assert.equal(response.status, 503);
  resolve({ snapshots: 0, proposals: 0 });
  await subject.flush();
  assert.equal(subject.calls.includes("recovery"), false);
});

test("pool closure is deferred and its failures cannot replace the maintenance result", async () => {
  const subject = fixture();
  subject.connection.pool.end = async () => { throw new Error("synthetic-secret-error"); };
  const response = await subject.handler(request());
  assert.equal(response.status, 200);
  await assert.doesNotReject(subject.flush());
});
