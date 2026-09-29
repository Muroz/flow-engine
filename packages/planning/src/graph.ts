/**
 * The planning graph.
 *
 *   START → intake → assessBrief ─(gaps)─► askQuestions → clarify 🙋 ─┐
 *                        ▲  │ complete                                │
 *                        └──┼─────────────────────────────────────────┘
 *                           ▼
 *                  writeRequirements → approveScope 🙋 ─(revise)─┐
 *                        ▲                 │ approve              │
 *                        └─────────────────┼──────────────────────┘
 *                                          ▼ (fan-out ×3 angles)
 *                  proposeOption ‖ proposeOption ‖ proposeOption
 *                                          ▼
 *                  compareOptions → pickArchitecture 🙋 → writeAdrs → breakdown ◄─┐
 *                                                                        ▼        │ gaps (max 2 rounds)
 *                                                                  checkCoverage ─┘
 *                                                                        ▼
 *                                                                  approvePlan 🙋 → emit → END
 */
import type { FlowDeps, LogEntry, PlannedTask } from "@flows/core";
import { Annotation, END, MemorySaver, Send, START, StateGraph } from "@langchain/langgraph";
import {
  afterAssess,
  afterCoverage,
  afterPick,
  afterPlanGate,
  approvePlan,
  approveScope,
  ARCH_ANGLES,
  askQuestions,
  assessBrief,
  breakdown,
  checkCoverage,
  clarify,
  compareOptions,
  emit,
  intake,
  pickArchitecture,
  proposeOption,
  writeAdrs,
  writeRequirements,
} from "./nodes";
import type { ArchOption, Coverage, DraftAdr, PlanningState, Requirement } from "./state";

const concat = <T>(a: T[], b: T[]): T[] => a.concat(b);
const last = <T>(_a: T, b: T): T => b;

export const PlanningAnnotation = Annotation.Root({
  briefPath: Annotation<string>,
  brief: Annotation<string | undefined>,
  briefComplete: Annotation<boolean | undefined>,
  discoveryRounds: Annotation<number>({ reducer: last, default: () => 0 }),
  questions: Annotation<string[]>({ reducer: last, default: () => [] }),
  requirements: Annotation<Requirement[]>({ reducer: last, default: () => [] }),
  scopeDecision: Annotation<PlanningState["scopeDecision"]>,
  options: Annotation<ArchOption[]>({ reducer: concat, default: () => [] }),
  currentAngle: Annotation<string | undefined>,
  recommendation: Annotation<string | undefined>,
  chosen: Annotation<ArchOption | undefined>,
  adrs: Annotation<DraftAdr[]>({ reducer: last, default: () => [] }),
  tasks: Annotation<PlannedTask[]>({ reducer: last, default: () => [] }),
  coverage: Annotation<Coverage[]>({ reducer: last, default: () => [] }),
  breakdownRounds: Annotation<number>({ reducer: last, default: () => 0 }),
  planApproved: Annotation<boolean | undefined>,
  emitted: Annotation<string[]>({ reducer: last, default: () => [] }),
  log: Annotation<LogEntry[]>({ reducer: concat, default: () => [] }),
});

export function buildPlanningGraph(deps: FlowDeps, opts: { outDir: string }) {
  // After scope approval: fan out one architecture proposal per angle.
  const afterScope = (s: PlanningState) => {
    if (s.scopeDecision === "approve") return ARCH_ANGLES.map((angle) => new Send("proposeOption", { ...s, currentAngle: angle }));
    return s.scopeDecision === "revise" ? "writeRequirements" : END;
  };

  return new StateGraph(PlanningAnnotation)
    .addNode("intake", intake)
    .addNode("assessBrief", assessBrief(deps))
    .addNode("askQuestions", askQuestions(deps))
    .addNode("clarify", clarify)
    .addNode("writeRequirements", writeRequirements(deps))
    .addNode("approveScope", approveScope)
    .addNode("proposeOption", proposeOption(deps))
    .addNode("compareOptions", compareOptions(deps))
    .addNode("pickArchitecture", pickArchitecture)
    .addNode("writeAdrs", writeAdrs(deps))
    .addNode("breakdown", breakdown(deps))
    .addNode("checkCoverage", checkCoverage(deps))
    .addNode("approvePlan", approvePlan)
    .addNode("emit", emit(opts.outDir))
    .addEdge(START, "intake")
    .addEdge("intake", "assessBrief")
    .addConditionalEdges("assessBrief", afterAssess, ["writeRequirements", "askQuestions"])
    .addEdge("askQuestions", "clarify")
    .addEdge("clarify", "assessBrief")
    .addEdge("writeRequirements", "approveScope")
    .addConditionalEdges("approveScope", afterScope, ["proposeOption", "writeRequirements", END])
    .addEdge("proposeOption", "compareOptions")
    .addEdge("compareOptions", "pickArchitecture")
    .addConditionalEdges("pickArchitecture", afterPick, ["writeAdrs", END])
    .addEdge("writeAdrs", "breakdown")
    .addEdge("breakdown", "checkCoverage")
    .addConditionalEdges("checkCoverage", afterCoverage, ["breakdown", "approvePlan"])
    .addConditionalEdges("approvePlan", afterPlanGate, ["emit", END])
    .addEdge("emit", END)
    .compile({ checkpointer: new MemorySaver() });
}
