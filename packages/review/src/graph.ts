/**
 * The review graph.
 *
 *   START → loadContext ─┬─► reviewer(spec)         ─┐
 *                        ├─► reviewer(correctness)  ─┤
 *                        ├─► reviewer(security)     ─┼─► aggregate → verify → triage → decide → writeReport → END
 *                        ├─► reviewer(tests)        ─┤
 *                        └─► reviewer(architecture) ─┘
 *
 * The fan-out uses `Send`: one shared `reviewer` node, invoked once per
 * specialist with a different `currentReviewer`. LangGraph runs the branches
 * in parallel and waits for all of them before `aggregate`. Their outputs are
 * combined by the `rawFindings` reducer (concat) — that's why reducers exist.
 */
import type { FlowDeps, Finding, LogEntry, TriagedFinding, Verdict } from "@flows/core";
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import { aggregate, decide, loadContext, report, reviewer, triage, verify } from "./nodes";
import { activeReviewers } from "./reviewers";
import type { MergedFinding, ReviewContext, ReviewInput, ReviewState, VerifiedFinding } from "./state";

const concat = <T>(a: T[], b: T[]): T[] => a.concat(b);

/** Mirrors `ReviewState` in state.ts, plus how parallel writes are merged. */
export const ReviewAnnotation = Annotation.Root({
  input: Annotation<ReviewInput>,
  context: Annotation<ReviewContext | undefined>,
  currentReviewer: Annotation<string | undefined>,
  rawFindings: Annotation<Finding[]>({ reducer: concat, default: () => [] }),
  merged: Annotation<MergedFinding[] | undefined>,
  verified: Annotation<VerifiedFinding[] | undefined>,
  findings: Annotation<TriagedFinding[] | undefined>,
  verdict: Annotation<Verdict | undefined>,
  verdictReason: Annotation<string | undefined>,
  report: Annotation<string | undefined>,
  log: Annotation<LogEntry[]>({ reducer: concat, default: () => [] }),
});

export function buildReviewGraph(deps: FlowDeps) {
  // Conditional edge that fans out: one Send per applicable specialist.
  const fanOut = (state: ReviewState) => {
    const specs = activeReviewers(deps.config.review.reviewers, state.context!);
    if (specs.length === 0) return "aggregate";
    return specs.map((spec) => new Send("reviewer", { ...state, currentReviewer: spec.id }));
  };

  return new StateGraph(ReviewAnnotation)
    .addNode("loadContext", loadContext(deps))
    .addNode("reviewer", reviewer(deps))
    .addNode("aggregate", aggregate)
    .addNode("verify", verify(deps))
    .addNode("triage", triage(deps))
    .addNode("decide", decide(deps))
    .addNode("writeReport", report)
    .addEdge(START, "loadContext")
    .addConditionalEdges("loadContext", fanOut, ["reviewer", "aggregate"])
    .addEdge("reviewer", "aggregate")
    .addEdge("aggregate", "verify")
    .addEdge("verify", "triage")
    .addEdge("triage", "decide")
    .addEdge("decide", "writeReport")
    .addEdge("writeReport", END)
    .compile();
}

export type ReviewGraph = ReturnType<typeof buildReviewGraph>;

/** Convenience wrapper: run a review and return the final state. */
export async function runReview(deps: FlowDeps, input: ReviewInput): Promise<ReviewState> {
  const graph = buildReviewGraph(deps);
  return (await graph.invoke({ input })) as ReviewState;
}
