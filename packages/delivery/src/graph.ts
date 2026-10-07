/**
 * The delivery graph — one planned task from plan to merge.
 *
 *   START → makePlan → assessRisk ─┬─(low)──────────────► implement ◄─────────────┐
 *                                  └─(else)─► approvePlan ─┘   │                   │
 *                                             🙋                ▼                   │
 *                                                          runChecks ─(fail, n<max)─┤
 *                                                              │ pass               │
 *                                                              ▼                    │
 *                                                      runReview (subgraph) ─(fix, n<max)
 *                                                              │ pass
 *                                   escalate 🙋 ◄─(escalate / n≥max)
 *                                       │ accept               ▼
 *                                       └──────────────► explainWork
 *                                                              ▼
 *                                                      approveMerge 🙋 → END
 *
 * You're involved at most three times — plan (only if risky), escalation
 * (only if stuck) and merge — and each time you get a one-screen summary.
 * `explainWork` writes a plain-language walkthrough before you decide to merge.
 */
import type { FlowDeps, LogEntry, PlannedTask, DiffSource } from "@flows/core";
import { buildReviewGraph } from "@flows/review";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import {
  afterChecks,
  afterEscalate,
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
  walkthrough: Annotation<DeliveryState["walkthrough"]>,
  outcome: Annotation<DeliveryState["outcome"]>,
  log: Annotation<LogEntry[]>({ reducer: concat, default: () => [] }),
});

export function buildDeliveryGraph(deps: FlowDeps) {
  const reviewGraph = buildReviewGraph(deps);

  return new StateGraph(DeliveryAnnotation)
    .addNode("makePlan", makePlan(deps))
    .addNode("assessRisk", assessRisk(deps))
    .addNode("approvePlan", approvePlan)
    .addNode("implement", implement(deps))
    .addNode("runChecks", runChecks(deps))
    .addNode("runReview", review(reviewGraph))
    .addNode("escalate", escalate(deps))
    .addNode("explainWork", explainWork(deps))
    .addNode("approveMerge", approveMerge(deps))
    .addEdge(START, "makePlan")
    .addEdge("makePlan", "assessRisk")
    .addConditionalEdges("assessRisk", afterRisk(deps), ["implement", "approvePlan"])
    .addConditionalEdges("approvePlan", afterPlanGate, ["implement", END])
    .addEdge("implement", "runChecks")
    .addConditionalEdges("runChecks", afterChecks(deps), ["runReview", "implement", "escalate"])
    .addConditionalEdges("runReview", afterReview(deps), ["explainWork", "implement", "escalate"])
    .addConditionalEdges("escalate", afterEscalate, ["implement", "explainWork", END])
    .addEdge("explainWork", "approveMerge")
    .addEdge("approveMerge", END)
    // Human gates need a checkpointer: that's what lets the graph pause and resume.
    .compile({ checkpointer: new MemorySaver() });
}
