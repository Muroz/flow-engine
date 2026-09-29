/**
 * Planning flow state — from a client brief to PRD, ADRs and a task DAG.
 * This is the flow where you spend most of your attention, on purpose.
 */
import type { LogEntry, PlannedTask } from "@flows/core";

export type Requirement = { id: string; text: string };

export type ArchOption = {
  id: string; // "A", "B", "C"
  angle: string; // the lens it was generated under
  summary: string;
  tradeoffs: string[];
};

export type DraftAdr = { id: string; title: string; context: string; decision: string; consequences: string };

export type Coverage = { requirementId: string; p: number; covered: boolean };

export type PlanningState = {
  briefPath: string;
  brief?: string;
  briefComplete?: boolean;
  discoveryRounds: number;
  questions: string[];

  requirements: Requirement[];
  scopeDecision?: "approve" | "revise" | "stop";

  /** Filled in parallel by the architecture fan-out (concat reducer). */
  options: ArchOption[];
  currentAngle?: string;
  recommendation?: string;
  chosen?: ArchOption;

  adrs: DraftAdr[];
  tasks: PlannedTask[];
  coverage: Coverage[];
  breakdownRounds: number;
  planApproved?: boolean;

  emitted: string[];
  log: LogEntry[];
};

export type PlanningUpdate = Partial<PlanningState>;
