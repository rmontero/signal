import assert from "node:assert/strict";
import test from "node:test";
import { loadApprovedProposalForExecution, loadUnknownOperation } from "../../src/db/repositories";
import type { SignalDb } from "../../src/db/client";

function dbFor(row: Record<string, unknown>): SignalDb {
  const chain = { from() { return this; }, innerJoin() { return this; }, where() { return this; }, async limit() { return [row]; } };
  return { select: () => chain } as unknown as SignalDb;
}
const mutation = { kind: "CREATE_ISSUE", repoId: "1", owner: "fixture", repo: "signal", title: "Review fixture", body: "Body\n<!-- signal-operation:op -->", assignees: [] };
test("execution and recovery loaders reject normalization of immutable persisted bytes", async () => {
  for (const state of ["APPROVED", "UNKNOWN"]) {
    const db = dbFor({ state, mutation: { ...mutation, title: " Review fixture " } });
    const loaded = state === "APPROVED"
      ? await loadApprovedProposalForExecution(db, { tenantId: "tenant", operationId: "op" })
      : await loadUnknownOperation(db, { tenantId: "tenant", operationId: "op", expectedAuthorLogin: "signal[bot]" });
    assert.equal(loaded, null);
  }
});
