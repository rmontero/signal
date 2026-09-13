import assert from "node:assert/strict";
import { test } from "node:test";
import { payloadHash, prepareMutation, type Analysis, type Mutation } from "../src/domain/contracts";
import { ProposalCardError, renderPersistedProposalCard, renderProposalCard, type ProposalCard } from "../src/services/proposal-card";

const analysis: Analysis = {
  decisions: [{ text: "Track migration", evidence: [{ messageTs: "1", permalink: "https://slack.example/1" }] }],
  tasks: [],
  blockers: [],
  uncertainties: ["Deadline is not explicit"],
};

const mutation: Mutation = {
  kind: "CREATE_ISSUE",
  repoId: "repo-1",
  owner: "acme",
  repo: "signal",
  title: "Track migration",
  body: "Evidence: https://slack.example/1\n<!-- signal-operation:op-1 -->",
  assignees: [],
};

test("renders a complete executable card with review and dismiss actions", () => {
  const card = renderProposalCard({ proposalId: "proposal-1", version: 1, mutation, analysis, analysisDurationMs: 1200, executable: true });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /acme\/signal/);
  assert.match(serialized, /Track migration/);
  assert.match(serialized, /Deadline is not explicit/);
  assert.match(serialized, /signal.review_proposal/);
  assert.match(serialized, /signal.dismiss_proposal/);
  assert.equal(card.blocks.filter((block) => block.type === "actions").length, 1);
});

function decodeText(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function renderedBody(card: ProposalCard, expectedLength: number): string {
  const label = card.blocks.findIndex((block) => block.type === "section" && ["Issue body", "Progress comment"].includes(block.text.text));
  assert.ok(label >= 0);
  let body = "";
  for (const block of card.blocks.slice(label + 1)) {
    if (body.length >= expectedLength) break;
    assert.equal(block.type, "section");
    if (block.type === "section") body += decodeText(block.text.text);
  }
  return body;
}

test("renders every immutable body byte, including marker and trailing whitespace", () => {
  const full = { ...mutation, body: "  first line\r\n" + "remaining payload ".repeat(280) + "\n<!-- signal-operation:op-1 -->\n  " };
  const before = JSON.stringify(full);
  const card = renderProposalCard({ proposalId: "p", version: 7, mutation: full, analysis, executable: true });
  assert.equal(renderedBody(card, full.body.length) === full.body, true);
  assert.equal(JSON.stringify(full) === before, true);
  assert.ok(card.blocks.filter((block) => block.type === "section").length > 3);
  assert.equal(JSON.stringify(card).includes("signal-operation:op-1"), true);
});

test("escaping expansion and Unicode never exceed Slack block limits or split entities", () => {
  for (const body of ["&".repeat(6_000), "😀".repeat(2_999), "<&>".repeat(2_000)]) {
    const card = renderProposalCard({ proposalId: "p", version: 1, mutation: { ...mutation, body }, analysis, executable: true });
    assert.equal(renderedBody(card, body.length) === body, true);
    for (const block of card.blocks) {
      if (block.type !== "section") continue;
      assert.ok(block.text.text.length <= 3_000);
      assert.equal(block.text.type, "plain_text");
      assert.equal(block.text.text.isWellFormed(), true);
      assert.equal(/&(?:a|am|amp|l|lt|g|gt)?$/.test(block.text.text), false);
    }
  }
});

test("Slack mentions, links, emphasis and code fences remain literal in every untrusted field", () => {
  const dangerous = "<!channel> <@U456> <https://evil.example|Approve> *forged* _owner_ ~done~ ```code``` &amp;";
  const hostileAnalysis = { ...analysis, uncertainties: [dangerous], decisions: [{ text: "Track migration", evidence: [{ messageTs: "1", permalink: "https://slack.example/1?label=<@U456>&other=1" }] }] };
  const hostile = { ...mutation, title: dangerous, body: dangerous };
  const card = renderProposalCard({ proposalId: "p", version: 1, mutation: hostile, analysis: hostileAnalysis, executable: false, status: dangerous });
  assert.equal(renderedBody(card, dangerous.length) === dangerous, true);
  for (const block of card.blocks) {
    if (block.type === "section") {
      assert.equal(block.text.type, "plain_text");
      assert.equal(/[<>]/.test(block.text.text), false);
    }
  }
  assert.equal(card.blocks.some((block) => block.type === "actions"), false);
});

test("all source links, full uncertainty and the actual assignee remain visible", () => {
  const links = Array.from({ length: 9 }, (_, index) => `https://slack.example/source/${index}`);
  const detailed: Analysis = { ...analysis, uncertainties: ["u".repeat(6_500)], decisions: [{ text: "Track migration", evidence: links.map((permalink, index) => ({ messageTs: String(index), permalink })) }] };
  const card = renderProposalCard({ proposalId: "p", version: 1, mutation: { ...mutation, assignees: ["octocat"] }, analysis: detailed, executable: true });
  const text = card.blocks.flatMap((block) => block.type === "section" ? [decodeText(block.text.text)] : []).join("");
  assert.equal(links.every((link) => text.includes(link)), true);
  assert.equal(text.includes(detailed.uncertainties[0]), true);
  assert.equal(text.includes("Assignee: octocat"), true);
});

function persisted(overrides: Record<string, unknown> = {}) {
  const operationId = "00000000-0000-4000-8000-000000000004";
  const storedMutation = prepareMutation(mutation, operationId);
  return {
    proposalId: "p", tenantId: "tenant-1", version: 4, operationId, mutation: storedMutation, analysis,
    payloadHash: payloadHash({ schemaVersion: 1, tenantId: "tenant-1", operationId, version: 4, mutation: storedMutation }),
    expiresAt: new Date("2026-09-12T12:30:00Z"), state: "PENDING",
    now: new Date("2026-09-12T12:00:00Z"), ...overrides,
  };
}

test("durable rendering uses only persisted analysis, version and exact immutable mutation", () => {
  const input = persisted();
  const before = JSON.stringify(input);
  const card = renderPersistedProposalCard(input);
  assert.equal(renderedBody(card, input.mutation.body.length) === input.mutation.body, true);
  assert.equal(JSON.stringify(input) === before, true);
  const actions = card.blocks.find((block) => block.type === "actions");
  assert.ok(actions?.type === "actions");
  assert.equal(actions.elements[0].value, "p:4");
  assert.equal(JSON.stringify(card).includes("Analysis: unavailable"), true);
});

test("persisted progress cards show their issue and comment without create-issue fields", () => {
  const input = persisted();
  const comment = prepareMutation({ kind: "ADD_PROGRESS_COMMENT", repoId: "repo-1", owner: "acme", repo: "signal", issueId: "4200", issueNumber: 42, body: "Verified the rollout\n" + "Details\n".repeat(500) }, input.operationId);
  const card = renderPersistedProposalCard({ ...input, mutation: comment, payloadHash: payloadHash({ schemaVersion: 1, tenantId: input.tenantId, operationId: input.operationId, version: input.version, mutation: comment }) });
  assert.equal(renderedBody(card, comment.body.length) === comment.body, true);
  assert.equal(JSON.stringify(card).includes("acme/signal#42"), true);
  assert.equal(JSON.stringify(card).includes("Issue title"), false);
  assert.equal(JSON.stringify(card).includes("Assignee:"), false);
});

test("terminal and expired persisted proposals have no review or dismiss controls", () => {
  for (const input of [
    ...["APPROVED", "DISMISSED", "SUPERSEDED", "EXPIRED"].map((state) => persisted({ state })),
    persisted({ now: new Date("2026-09-12T12:30:00Z") }),
  ]) {
    const card = renderPersistedProposalCard(input);
    assert.equal(card.blocks.some((block) => block.type === "actions"), false);
  }
});

test("missing retention data, mismatched identity/hash and normalized payloads cannot render approval", () => {
  for (const input of [
    persisted({ analysis: null }), persisted({ mutation: null }), persisted({ version: 5 }),
    persisted({ tenantId: "other-tenant" }), persisted({ payloadHash: "wrong" }),
    persisted({ state: "UNKNOWN" }), persisted({ expiresAt: "bad-date" }),
    persisted({ mutation: { ...mutation, title: " Trailing space " } }),
  ]) assert.throws(() => renderPersistedProposalCard(input), ProposalCardError);
});

test("oversized rendering fails instead of truncating or enabling an incomplete proposal", () => {
  assert.throws(() => renderProposalCard({ proposalId: "p", version: 1, mutation: { ...mutation, body: "x".repeat(6_001) }, analysis, executable: true }), ProposalCardError);
  assert.throws(() => renderProposalCard({ proposalId: "p", version: 1, mutation, analysis: { ...analysis, uncertainties: ["&".repeat(40_000)] }, executable: true }), ProposalCardError);
  assert.throws(() => renderProposalCard({ proposalId: "p", version: 1, analysis, executable: true }), ProposalCardError);
});

test("renders non-executable outcomes without approval controls", () => {
  const card = renderProposalCard({
    proposalId: "proposal-1",
    version: 1,
    mutation,
    analysis,
    analysisDurationMs: 1200,
    executable: false,
    status: "No actionable request was found; clarify the thread and invoke Signal again.",
  });
  assert.equal(card.blocks.some((block) => block.type === "actions"), false);
  assert.match(JSON.stringify(card), /No actionable request/);
});

test("can explain no-action outcomes without requiring mutation data", () => {
  const card = renderProposalCard({
    proposalId: "proposal-1",
    version: 1,
    analysis,
    analysisDurationMs: 12,
    executable: false,
    status: "No actionable request was found.",
  });
  assert.match(JSON.stringify(card), /No executable action/);
  assert.equal(card.blocks.some((block) => block.type === "actions"), false);
});
