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
 *                  proposeOption ‖ proposeOption ‖ proposeOption ◄──(revise)──┐
 *                                          ▼                                  │
 *                  compareOptions ◄── adjustOption ◄──(adjust)────────────────┤
 *                         ▼                                                   │
 *                  pickArchitecture 🙋 ───────────────────────────────────────┘
 *                         ▼ pick
 *                  writeAdrs → breakdown ◄─┐
 *                                ▼        │ gaps (max 2 rounds)
 *                          checkCoverage ─┘
 *                                ▼
 *                          approvePlan 🙋 → emit → END
 *
 * Only MVP requirements reach the architecture, ADR and task nodes.
 */
import type { FlowDeps, LogEntry, PlannedTask } from "@flows/core";
import { Annotation, END, MemorySaver, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  adjustOption,
  afterAssess,
  afterCoverage,
  afterPick,
  afterPlanGate,
  afterScope,
  approvePlan,
  approveScope,
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

/** A rerun of the fan-out or an adjust replaces options by ID instead of adding copies. */
export const mergeOptions = (a: ArchOption[], b: ArchOption[]): ArchOption[] => {
  const byId = new Map(a.map((o) => [o.id, o]));
  for (const o of b) byId.set(o.id, o);
  return [...byId.values()].sort((x, y) => x.id.localeCompare(y.id));
};

export const PlanningAnnotation = Annotation.Root({
  briefPath: Annotation<string>,
  brief: Annotation<string | undefined>,
  briefComplete: Annotation<boolean | undefined>,
  discoveryRounds: Annotation<number>({ reducer: last, default: () => 0 }),
  questions: Annotation<string[]>({ reducer: last, default: () => [] }),
  requirements: Annotation<Requirement[]>({ reducer: last, default: () => [] }),
  previousRequirements: Annotation<Requirement[]>({ reducer: last, default: () => [] }),
  scopeDecision: Annotation<PlanningState["scopeDecision"]>,
  scopeFeedback: Annotation<string | undefined>,
  options: Annotation<ArchOption[]>({ reducer: mergeOptions, default: () => [] }),
  currentAngle: Annotation<string | undefined>,
  recommendation: Annotation<string | undefined>,
  chosen: Annotation<ArchOption | undefined>,
  archDecision: Annotation<PlanningState["archDecision"]>,
  archFeedback: Annotation<string | undefined>,
  adjustTarget: Annotation<string | undefined>,
  adrs: Annotation<DraftAdr[]>({ reducer: last, default: () => [] }),
  tasks: Annotation<PlannedTask[]>({ reducer: last, default: () => [] }),
  coverage: Annotation<Coverage[]>({ reducer: last, default: () => [] }),
  breakdownRounds: Annotation<number>({ reducer: last, default: () => 0 }),
  planApproved: Annotation<boolean | undefined>,
  emitted: Annotation<string[]>({ reducer: last, default: () => [] }),
  log: Annotation<LogEntry[]>({ reducer: concat, default: () => [] }),
});

export type PlanningGraphOptions = {
  /** Where `emit` writes: a proposal folder, or the artifacts folder with --write. */
  outDir: string;
  /** Where gates write their detail files. Defaults to `outDir`. */
  detailDir?: string;
  checkpointer?: BaseCheckpointSaver;
};

export function buildPlanningGraph(deps: FlowDeps, opts: PlanningGraphOptions) {
  const detailDir = opts.detailDir ?? opts.outDir;
  return new StateGraph(PlanningAnnotation)
    .addNode("intake", intake)
    .addNode("assessBrief", assessBrief(deps))
    .addNode("askQuestions", askQuestions(deps))
    .addNode("clarify", clarify)
    .addNode("writeRequirements", writeRequirements(deps))
    .addNode("approveScope", approveScope(detailDir))
    .addNode("proposeOption", proposeOption(deps))
    .addNode("compareOptions", compareOptions(deps))
    .addNode("adjustOption", adjustOption(deps))
    .addNode("pickArchitecture", pickArchitecture(detailDir))
    .addNode("writeAdrs", writeAdrs(deps))
    .addNode("breakdown", breakdown(deps))
    .addNode("checkCoverage", checkCoverage(deps))
    .addNode("approvePlan", approvePlan(detailDir))
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
    .addConditionalEdges("pickArchitecture", afterPick, ["writeAdrs", "adjustOption", "proposeOption", END])
    .addEdge("adjustOption", "compareOptions")
    .addEdge("writeAdrs", "breakdown")
    .addEdge("breakdown", "checkCoverage")
    .addConditionalEdges("checkCoverage", afterCoverage, ["breakdown", "approvePlan"])
    .addConditionalEdges("approvePlan", afterPlanGate, ["emit", END])
    .addEdge("emit", END)
    .compile({ checkpointer: opts.checkpointer ?? new MemorySaver() });
}
