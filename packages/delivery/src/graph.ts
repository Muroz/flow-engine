/**
 * The delivery graph — one planned task from plan to merge.
 *
 *   START → makePlan ◄──(revise)──────────────── approvePlan (gate)
 *              ▼                                    ▲      │ approve
 *           assessRisk ─(above autoApproveRisk)─────┘      ▼
 *              └─(otherwise)──────────────────────────► implement ◄───────────────────────────┐
 *                                                          ▼                                  │
 *                                                      runChecks ─(fail, attempts left)───────┤
 *                                                          ▼ pass                             │
 *                                                  runReview (subgraph) ─(fix, attempts left)─┤
 *                                                          │ pass                             │
 *            escalate (gate) ◄─(escalate, out of attempts or over budget)                     │
 *              │ retry ───────────────────────────────────────────────────────────────────────┤
 *              │ accept                                    ▼                                  │
 *              └─────────────────────────────────► explainWork                                │
 *                                                          ▼                                  │
 *                                                 approveMerge (gate) ─(fix)──────────────────┘
 *                                                          ▼ merge or reject
 *                                                         END
 *
 * Three gates: the plan (only if risky), escalation (only if stuck) and the
 * merge. revise, retry and fix can bring you back to one. Each gate fits on
 * one screen.
 * `explainWork` writes a plain-language walkthrough before you decide to merge.
 */
import type { FlowDeps, LogEntry, PlannedTask, DiffSource } from "@flows/core";
import { buildReviewGraph } from "@flows/review";
import { Annotation, END, MemorySaver, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  afterChecks,
  afterEscalate,
  afterMerge,
  afterPlanGate,
  afterReview,
  afterRisk,
  approveMerge,
  approvePlan,
  assessRisk,
  escalate,
  implement,
  explainWork,
  makePlan,
  review,
  runChecks,
} from "./nodes";
import type { DeliveryPlan, DeliveryState } from "./state";

const concat = <T>(a: T[], b: T[]): T[] => a.concat(b);

export const DeliveryAnnotation = Annotation.Root({
  task: Annotation<PlannedTask>,
  diffSource: Annotation<DiffSource>,
  base: Annotation<string>,
  runId: Annotation<string>,
  plan: Annotation<DeliveryPlan | undefined>,
  attempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  diff: Annotation<string | undefined>,
  workdir: Annotation<string | undefined>,
  checks: Annotation<DeliveryState["checks"]>,
  review: Annotation<DeliveryState["review"]>,
  fixNotes: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  planFeedback: Annotation<string | undefined>,
  budgetFrom: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  walkthrough: Annotation<DeliveryState["walkthrough"]>,
  outcome: Annotation<DeliveryState["outcome"]>,
  log: Annotation<LogEntry[]>({ reducer: concat, default: () => [] }),
});

export function buildDeliveryGraph(deps: FlowDeps, opts: { checkpointer?: BaseCheckpointSaver } = {}) {
  const reviewGraph = buildReviewGraph(deps);

  return new StateGraph(DeliveryAnnotation)
    .addNode("makePlan", makePlan(deps))
    .addNode("assessRisk", assessRisk(deps))
    .addNode("approvePlan", approvePlan)
    .addNode("implement", implement(deps))
    .addNode("runChecks", runChecks(deps))
    .addNode("runReview", review(deps, reviewGraph))
    .addNode("escalate", escalate(deps))
    .addNode("explainWork", explainWork(deps))
    .addNode("approveMerge", approveMerge(deps))
    .addEdge(START, "makePlan")
    .addEdge("makePlan", "assessRisk")
    .addConditionalEdges("assessRisk", afterRisk(deps), ["implement", "approvePlan"])
    .addConditionalEdges("approvePlan", afterPlanGate, ["makePlan", "implement", END])
    .addEdge("implement", "runChecks")
    .addConditionalEdges("runChecks", afterChecks(deps), ["runReview", "implement", "escalate"])
    .addConditionalEdges("runReview", afterReview(deps), ["explainWork", "implement", "escalate"])
    .addConditionalEdges("escalate", afterEscalate(deps), ["implement", "explainWork", END])
    .addEdge("explainWork", "approveMerge")
    .addConditionalEdges("approveMerge", afterMerge, ["implement", END])
    // Human gates need a checkpointer: that's what lets the graph pause and resume.
    .compile({ checkpointer: opts.checkpointer ?? new MemorySaver() });
}
