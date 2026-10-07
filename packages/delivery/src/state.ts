/**
 * Delivery flow state — one planned task, from plan to merge.
 */
import type { DiffSource, LogEntry, PlannedTask, Risk, TriagedFinding, Verdict } from "@flows/core";

export type DeliveryPlan = { summary: string; steps: string[]; risk: Risk };

export type DeliveryState = {
  // ── input ──
  task: PlannedTask;
  /** Where the "diff-file" agent gets its diff. Ignored by "claude-code". */
  diffSource: DiffSource;
  /** Branch the agent's worktree starts from and diffs against. */
  base: string;
  runId: string;

  // ── work ──
  plan?: DeliveryPlan;
  attempts: number; // stop rule counter
  diff?: string;
  /** The agent's git worktree, when it has one. Checks run here. */
  workdir?: string;
  checks?: { passed: boolean; output: string };
  /** Mapped back from the review subgraph — only what delivery needs. */
  review?: { verdict: Verdict; reason: string; findings: TriagedFinding[]; report: string };
  /** What the next implementation attempt must address (from checks or review). */
  fixNotes: string[];
  /** Plain-language explanation of the work, written before the merge gate. */
  walkthrough?: { path: string; gist: string };

  // ── result ──
  outcome?: "merged" | "rejected" | "escalated";
  log: LogEntry[];
};

export type DeliveryUpdate = Partial<DeliveryState>;
