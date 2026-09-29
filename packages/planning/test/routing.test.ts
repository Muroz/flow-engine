import assert from "node:assert/strict";
import { test } from "node:test";
import { afterAssess, afterCoverage } from "../src/nodes";
import type { PlanningState } from "../src/state";

const s = (over: Partial<PlanningState>) => ({ discoveryRounds: 0, breakdownRounds: 1, coverage: [], ...over }) as PlanningState;

test("discovery loops at most twice before writing requirements anyway", () => {
  assert.equal(afterAssess(s({ briefComplete: false })), "askQuestions");
  assert.equal(afterAssess(s({ briefComplete: false, discoveryRounds: 2 })), "writeRequirements");
  assert.equal(afterAssess(s({ briefComplete: true })), "writeRequirements");
});

test("coverage gaps send the breakdown back once, then go to you", () => {
  const gap = [{ requirementId: "R-4", p: 0.1, covered: false }];
  assert.equal(afterCoverage(s({ coverage: gap, breakdownRounds: 1 })), "breakdown");
  assert.equal(afterCoverage(s({ coverage: gap, breakdownRounds: 2 })), "approvePlan");
});
