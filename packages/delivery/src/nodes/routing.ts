/**
 * The conditional edges. Each takes the state after a node and names the
 * next node. Policy lives here, so routing.test.ts tests it with hand-built
 * states and no graph.
 */
import type { FlowDeps } from "@flows/core";
import { END } from "@langchain/langgraph";
import type { DeliveryState } from "../state";
import { overBudget } from "./shared";

const riskRank = (r: string) => ["none", "low", "medium", "high"].indexOf(r);

/** Skips the plan gate when the plan's risk is at or below `delivery.autoApproveRisk`. */
export const afterRisk = (deps: FlowDeps) => (s: DeliveryState) =>
  riskRank(s.plan!.risk) <= riskRank(deps.config.delivery.autoApproveRisk) ? "implement" : "approvePlan";

/** After the plan gate: reject ends the run, revise goes back to `makePlan`, approve goes on. */
export const afterPlanGate = (s: DeliveryState) => (s.outcome === "rejected" ? END : s.planFeedback ? "makePlan" : "implement");

/** An empty diff skips checks and review, which would pass the untouched code. */
export const afterImplement = (deps: FlowDeps) => (s: DeliveryState) => (!deps.offline && !s.diff?.trim() ? "escalate" : "runChecks");

/** Passing checks go to review. Failing ones retry while attempts and budget last, then escalate. */
export const afterChecks = (deps: FlowDeps) => (s: DeliveryState) => {
  if (s.checks?.passed) return "runReview";
  return s.attempts < deps.config.delivery.maxAttempts && !overBudget(deps, s) ? "implement" : "escalate";
};

/** pass goes to the walkthrough, fix retries while attempts and budget last, anything else escalates. */
export const afterReview = (deps: FlowDeps) => (s: DeliveryState) => {
  const v = s.review?.verdict;
  if (v === "pass") return "explainWork";
  if (v === "fix" && s.attempts < deps.config.delivery.maxAttempts && !overBudget(deps, s)) return "implement";
  return "escalate";
};

/** Routes on your answer. The gate can open with attempts left, so the attempt count can't stand in for it. */
export const afterEscalate = (s: DeliveryState) => (s.outcome ? END : s.escalation === "accept" ? "explainWork" : "implement");

/** After the merge gate: merge or reject ends the run, fix goes back to `implement`. */
export const afterMerge = (s: DeliveryState) => (s.outcome ? END : "implement");
