/**
 * Delivery flow state — one planned task, from plan to merge.
 */
import type { DiffSource, LogEntry, PlannedTask, Risk, TriagedFinding, Verdict } from "@flows/core";

export type DeliveryPlan = { summary: string; steps: string[]; risk: Risk };

export type DeliveryState = {
  // ── input ──
  task: PlannedTask;
  /** Demo only: where "implement" gets its diff until a real coding agent is plugged in. */
  diffSource: DiffSource;
  runId: string;

  // ── work ──
  plan?: DeliveryPlan;
  attempts: number; // stop rule counter
  diff?: string;
  checks?: { passed: boolean; output: string };
  /** Mapped back from the review subgraph — only what delivery needs. */
  review?: { verdict: Verdict; reason: string; findings: TriagedFinding[]; report: string };
  /** What the next implementation attempt must address (from checks or review). */
  fixNotes: string[];

  // ── result ──
  outcome?: "merged" | "rejected" | "escalated";
  log: LogEntry[];
};

export type DeliveryUpdate = Partial<DeliveryState>;
