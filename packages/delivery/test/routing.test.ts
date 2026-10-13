/**
 * Conditional edges are plain functions of state — test the policy directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockJudge, MockModelClient, type FlowDeps, type ProjectConfig } from "@flows/core";
import { END } from "@langchain/langgraph";
import { afterChecks, afterEscalate, afterImplement, afterMerge, afterPlanGate, afterReview, afterRisk, pickComments } from "../src/nodes";
import type { DeliveryState } from "../src/state";

const deps = {
  config: { delivery: { maxAttempts: 3, autoApproveRisk: "low", checks: [], maxCostUsd: 5, retryAttempts: 1 } } as unknown as ProjectConfig,
  model: new MockModelClient(),
  judge: new MockJudge(),
  offline: true,
  backends: [],
} satisfies FlowDeps;

const s = (over: Partial<DeliveryState>): DeliveryState =>
  ({ attempts: 1, fixNotes: [], log: [], budgetFrom: 0, plan: { summary: "", steps: [], risk: "low" }, ...over }) as DeliveryState;

test("low-risk plans skip the human gate; others don't", () => {
  assert.equal(afterRisk(deps)(s({})), "implement");
  assert.equal(afterRisk(deps)(s({ plan: { summary: "", steps: [], risk: "medium" } })), "approvePlan");
});

test("an empty diff skips checks and review and goes to you", () => {
  const online = { ...deps, offline: false };
  assert.equal(afterImplement(online)(s({ diff: "" })), "escalate");
  assert.equal(afterImplement(online)(s({ diff: "diff --git a/x b/x" })), "runChecks");
  assert.equal(afterImplement(deps)(s({ diff: "" })), "runChecks", "offline runs replay a diff file");
});

test("failing checks loop until the stop rule, then escalate", () => {
  const failed = { passed: false, output: "x", results: [] };
  assert.equal(afterChecks(deps)(s({ checks: failed, attempts: 2 })), "implement");
  assert.equal(afterChecks(deps)(s({ checks: failed, attempts: 3 })), "escalate");
});

test("review verdicts route to the walkthrough, another attempt, or you", () => {
  const r = (verdict: "pass" | "fix" | "escalate") => ({ verdict, reason: "", findings: [], report: "" });
  assert.equal(afterReview(deps)(s({ review: r("pass") })), "explainWork");
  assert.equal(afterReview(deps)(s({ review: r("fix"), attempts: 1 })), "implement");
  assert.equal(afterReview(deps)(s({ review: r("fix"), attempts: 3 })), "escalate");
  assert.equal(afterReview(deps)(s({ review: r("escalate") })), "escalate");
});

test("escalation: abort ends, retry grants attempts, accept goes to the walkthrough", () => {
  assert.equal(afterEscalate(deps)(s({ outcome: "escalated" })), END);
  assert.equal(afterEscalate(deps)(s({ attempts: 2 })), "implement");
  assert.equal(afterEscalate(deps)(s({ attempts: 3 })), "explainWork");
});

test("spend over the cost limit stops the loop, counting from the last retry", () => {
  const spent = (usd: number) => [{ node: "review.correctness", at: "", costUsd: usd }];
  const r = { verdict: "fix" as const, reason: "", findings: [], report: "" };
  assert.equal(afterReview(deps)(s({ review: r, log: spent(5.2) })), "escalate");
  assert.equal(afterReview(deps)(s({ review: r, log: spent(5.2), budgetFrom: 4 })), "implement");
});

test("plan gate: revise writes a new plan, reject ends", () => {
  assert.equal(afterPlanGate(s({ planFeedback: "smaller steps" })), "makePlan");
  assert.equal(afterPlanGate(s({ outcome: "rejected" })), END);
  assert.equal(afterPlanGate(s({})), "implement");
});

test("merge gate: fix goes back to implement, merge and reject end", () => {
  assert.equal(afterMerge(s({})), "implement");
  assert.equal(afterMerge(s({ outcome: "merged" })), END);
});

test("fix at the merge gate picks all comments, some by number, or your own text", () => {
  const comments = ["a", "b", "c"];
  assert.deepEqual(pickComments(comments, undefined), ["a", "b", "c"]);
  assert.deepEqual(pickComments(comments, "1, 3"), ["a", "c"]);
  assert.deepEqual(pickComments(comments, "2: also rename it"), ["b", "also rename it"]);
  assert.deepEqual(pickComments(comments, "rename the helper"), ["rename the helper"]);
});

test("the agent's prompt lists the project standards to read first", async () => {
  const { agentPrompt } = await import("../src/nodes");
  const withStandards = {
    ...deps,
    config: {
      ...deps.config,
      artifactsDir: "/nowhere",
      conventions: [],
      standards: [{ path: "docs/standards/modules.md", reviewers: ["architecture"] }],
    } as unknown as ProjectConfig,
  };
  const task = { id: "T-1", title: "Thing", requirementIds: [], adrRefs: [], dependsOn: [], acceptanceCriteria: ["works"], risk: "low" as const };
  const prompt = agentPrompt(s({ task }), withStandards);
  assert.match(prompt, /Read these project standards before you start[\s\S]*- docs\/standards\/modules\.md/);
  assert.match(prompt, /AUDIENCE: A developer/);
});

test("the agent may decline a note, and the declines match the ledger by title", async () => {
  const { parseDeclines, openItems } = await import("../src/nodes");
  const ledger = [
    { round: 3, reviewer: "correctness", severity: "major" as const, title: "Move the shared database client under src/lib", rationale: "", status: "sent" as const },
  ];
  const text = "Fixed the rest.\n\nDeclined: [major] Move the shared database client under src/lib — ADR-0007 puts it in src/db/client.ts\n";
  const declined = parseDeclines(text, ledger, 4);
  assert.equal(declined.length, 1);
  assert.equal(declined[0]!.reviewer, "correctness");
  assert.equal(declined[0]!.status, "declined");
  assert.equal(declined[0]!.round, 4);
  assert.match(declined[0]!.note!, /ADR-0007/);
  assert.deepEqual(parseDeclines("All fixed.", ledger, 4), []);
  assert.deepEqual(openItems([...ledger, ...declined]), [
    "round 4, declined by the agent: Move the shared database client under src/lib (ADR-0007 puts it in src/db/client.ts)",
  ]);
  assert.deepEqual(openItems(ledger), [], "a sent finding isn't open");
});

test("a follow-up round tells the agent how to decline a note", async () => {
  const { agentPrompt } = await import("../src/nodes");
  const cfg = { ...deps, config: { ...deps.config, artifactsDir: "/nowhere", conventions: [], standards: [] } as unknown as ProjectConfig };
  const task = { id: "T-1", title: "Thing", requirementIds: [], adrRefs: [], dependsOn: [], acceptanceCriteria: ["works"], risk: "low" as const };
  assert.match(agentPrompt(s({ task, fixNotes: ["[major] X"] }), cfg), /Declined: <note title> — <reason>/);
  assert.doesNotMatch(agentPrompt(s({ task }), cfg), /Declined:/);
});
