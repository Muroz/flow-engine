/**
 * Shared contracts between flows.
 *
 * Flows never share in-memory state. They communicate through artifacts
 * (PRD, ADRs, tasks.yaml, diffs) and the types in this file are the shape
 * of those artifacts once loaded.
 */

// ── Planning → Delivery contract ────────────────────────────────────────────

/** One unit of work emitted by the planning flow into plan/tasks.yaml. */
export type PlannedTask = {
  id: string; // "T-014"
  title: string;
  requirementIds: string[]; // traceability back to the PRD
  adrRefs: string[]; // decisions this task must respect, e.g. ["ADR-0001"]
  dependsOn: string[]; // DAG edges between tasks
  acceptanceCriteria: string[]; // what reviewers/verifiers check against
  risk: Risk;
  estimate?: "S" | "M" | "L";
};

export type Risk = "low" | "medium" | "high";

// ── Review contract ─────────────────────────────────────────────────────────

export const SEVERITIES = ["nit", "minor", "major", "blocker"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A finding as proposed by a specialist reviewer, before triage. */
export type Finding = {
  reviewer: string; // which specialist raised it
  title: string;
  file?: string;
  line?: number;
  severity: Severity; // the reviewer's own opinion
  rationale: string;
  suggestion?: string;
};

/** A finding after the judge has scored it. */
export type TriagedFinding = Finding & {
  judgedSeverity: Severity;
  confidence: number; // 0..1 — how sure the judge is this is a real problem
  kept: boolean; // false = filtered as noise
  alsoRaisedBy?: string[]; // other reviewers that flagged the same thing
};

export type Verdict = "pass" | "fix" | "escalate";

// ── Provenance ──────────────────────────────────────────────────────────────

/** Written by every node. This is what lets you skip the details and still trust the result. */
export type LogEntry = {
  node: string;
  at: string; // ISO timestamp
  model?: string;
  costUsd?: number;
  note?: string;
};
