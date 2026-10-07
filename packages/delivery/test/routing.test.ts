/**
 * Conditional edges are plain functions of state — test the policy directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockJudge, MockModelClient, type FlowDeps, type ProjectConfig } from "@flows/core";
import { END } from "@langchain/langgraph";
import { afterChecks, afterEscalate, afterReview, afterRisk } from "../src/nodes";
import type { DeliveryState } from "../src/state";

const deps = {
  config: { delivery: { maxAttempts: 3, autoApproveRisk: "low", checks: [] } } as unknown as ProjectConfig,
  model: new MockModelClient(),
  judge: new MockJudge(),
  offline: true,
  backends: [],
} satisfies FlowDeps;

const s = (over: Partial<DeliveryState>): DeliveryState =>
  ({ attempts: 1, fixNotes: [], log: [], plan: { summary: "", steps: [], risk: "low" }, ...over }) as DeliveryState;

test("low-risk plans skip the human gate; others don't", () => {
  assert.equal(afterRisk(deps)(s({})), "implement");
  assert.equal(afterRisk(deps)(s({ plan: { summary: "", steps: [], risk: "medium" } })), "approvePlan");
});

test("failing checks loop until the stop rule, then escalate", () => {
  const failed = { passed: false, output: "x" };
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

test("escalation: abort ends, retry resets, accept goes to the walkthrough", () => {
  assert.equal(afterEscalate(s({ outcome: "escalated" })), END);
  assert.equal(afterEscalate(s({ attempts: 0 })), "implement");
  assert.equal(afterEscalate(s({ attempts: 3 })), "explainWork");
});
