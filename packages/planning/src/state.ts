/**
 * Planning flow state — from a client brief to PRD, ADRs and a task DAG.
 * This is the flow where you spend most of your attention, on purpose.
 */
import type { LogEntry, PlannedTask } from "@flows/core";

export type Requirement = {
  id: string;
  /** At most eight words, for gate summaries. */
  title: string;
  text: string;
  /** Feature area the scope gate groups by. */
  area: string;
  /** Only "mvp" requirements reach architecture, ADRs and tasks. */
  priority: "mvp" | "later";
};

export type ArchFacts = { firstDelivery: string; monthlyCost: string; opsBurden: string; lockIn: string };

export type ArchOption = {
  id: string; // "A", "B", "C"
  angle: string; // the lens it was generated under
  pitch: string;
  facts: ArchFacts;
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
  /** The list before the last revise, so the gate can show what changed. */
  previousRequirements: Requirement[];
  scopeDecision?: "approve" | "revise" | "discard";
  scopeFeedback?: string;

  /** Filled in parallel by the architecture fan-out (concat reducer). */
  options: ArchOption[];
  currentAngle?: string;
  recommendation?: string;
  chosen?: ArchOption;
  archDecision?: "pick" | "revise" | "adjust" | "discard";
  archFeedback?: string;
  adjustTarget?: string;

  adrs: DraftAdr[];
  tasks: PlannedTask[];
  coverage: Coverage[];
  breakdownRounds: number;
  planApproved?: boolean;

  emitted: string[];
  log: LogEntry[];
};

export type PlanningUpdate = Partial<PlanningState>;
