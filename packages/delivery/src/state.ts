/**
 * Delivery flow state — one planned task, from plan to merge.
 */
import type { DiffSource, LogEntry, PlannedTask, PriorFinding, Risk, TriagedFinding, Verdict } from "@flows/core";

export type DeliveryPlan = { summary: string; steps: string[]; risk: Risk };

export type CheckResult = { command: string; status: "passed" | "failed" | "not run"; seconds: number };

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
  /** Your notes from "revise" at the plan gate, for the next plan. */
  planFeedback?: string;
  attempts: number; // stop rule counter
  diff?: string;
  /** The agent's git worktree, when it has one. Checks run here. */
  workdir?: string;
  checks?: { passed: boolean; output: string; results: CheckResult[] };
  /** Git tree of the worktree after the last implement round. */
  tree?: string;
  /** Git tree the last review saw. Later rounds review what changed since. */
  reviewedTree?: string;
  /** Mapped back from the review subgraph — only what delivery needs. Conflicts are findings left for you to decide. */
  review?: {
    verdict: Verdict;
    reason: string;
    findings: TriagedFinding[];
    conflicts?: TriagedFinding[];
    report: string;
    reportPath?: string;
  };
  /** Every finding sent to the agent, declined by it, or left for you, across rounds. Later reviews see it. */
  ledger: PriorFinding[];
  /** What the next implementation attempt must address (from checks or review). */
  fixNotes: string[];
  /** Spend at the last retry or fix. The cost limit counts from here. */
  budgetFrom: number;
  /** Plain-language explanation of the work, written before the merge gate. */
  walkthrough?: { path: string; gist: string };

  // ── result ──
  outcome?: "merged" | "rejected" | "escalated";
  log: LogEntry[];
};

export type DeliveryUpdate = Partial<DeliveryState>;
