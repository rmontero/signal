import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis, Mutation } from "../src/domain/contracts";
import { renderProposalCard } from "../src/services/proposal-card";

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

test("renders a compact executable card with review and dismiss actions", () => {
  const card = renderProposalCard({ proposalId: "proposal-1", version: 1, mutation, analysis, analysisDurationMs: 1200, executable: true });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /acme\/signal/);
  assert.match(serialized, /Track migration/);
  assert.match(serialized, /Deadline is not explicit/);
  assert.match(serialized, /signal.review_proposal/);
  assert.match(serialized, /signal.dismiss_proposal/);
  assert.equal(card.blocks.filter((block) => block.type === "actions").length, 1);
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
