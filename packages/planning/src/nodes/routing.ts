/**
 * The conditional edges. Each takes the state after a node and names the
 * next node, or returns one `Send` per branch for a fan-out.
 */
import { END, Send } from "@langchain/langgraph";
import type { PlanningState } from "../state";
import { ARCH_ANGLES } from "./propose-option";

/** A complete brief, or two rounds of questions, goes on to requirements. Otherwise ask again. */
export const afterAssess = (s: PlanningState) => (s.briefComplete || s.discoveryRounds >= 2 ? "writeRequirements" : "askQuestions");

/** approve fans out to the architecture options, revise rewrites the requirements, discard ends the run. */
export const afterScope = (s: PlanningState) => {
  if (s.scopeDecision === "approve") return proposeAll(s);
  return s.scopeDecision === "revise" ? "writeRequirements" : END;
};

/** One `proposeOption` branch per angle. */
export const proposeAll = (s: PlanningState) => ARCH_ANGLES.map((angle) => new Send("proposeOption", { ...s, currentAngle: angle }));

/** pick goes on to the ADRs, adjust reworks one option, revise proposes all again, discard ends the run. */
export const afterPick = (s: PlanningState) => {
  if (s.archDecision === "pick" && s.chosen) return "writeAdrs";
  if (s.archDecision === "adjust") return "adjustOption";
  if (s.archDecision === "revise") return proposeAll(s);
  return END;
};

/** Coverage gaps get one more breakdown round, at most two in all. Then the plan gate. */
export const afterCoverage = (s: PlanningState) =>
  s.coverage.some((c) => !c.covered) && s.breakdownRounds < 2 ? "breakdown" : "approvePlan";

/** An approved plan goes to `emit`; a discarded one ends the run. */
export const afterPlanGate = (s: PlanningState) => (s.planApproved ? "emit" : END);
