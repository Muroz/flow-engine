/**
 * Review flow state — plain types, no framework imports.
 *
 * graph.ts mirrors this shape as a LangGraph Annotation and adds reducers.
 * Keeping the plain types separate means every node is an ordinary function
 * you can unit-test without spinning up a graph.
 */
import type { AdrRef, Finding, LogEntry, PlannedTask, Standard, TriagedFinding, Verdict } from "@flows/core";

/** What the caller hands in. */
export type ReviewInput = {
  diff: string;
  /** Present when reviewing planned work — enables the spec-conformance reviewer. */
  task?: PlannedTask;
  /** Human label for reports: "PR #42", "T-014 attempt 2", a diff file name. */
  label: string;
};

/** Loaded once by `loadContext`; each reviewer receives only a view of it. */
export type ReviewContext = {
  /** The diff without generated files. */
  diff: string;
  files: string[];
  /** Generated files left out of the review, such as lockfiles. */
  skipped: string[];
  /** Project standards; each reviewer sees the ones listed for it. */
  standards: Standard[];
  task?: PlannedTask;
  adrs: AdrRef[];
  conventions: string[];
};

/** A finding after de-duplication across reviewers. */
export type MergedFinding = Finding & { alsoRaisedBy: string[] };

export type ReviewState = {
  input: ReviewInput;
  context?: ReviewContext;
  /** Set on each fan-out branch so the shared `reviewer` node knows which specialist it is. */
  currentReviewer?: string;
  /** Appended to by every reviewer branch (concat reducer). */
  rawFindings: Finding[];
  merged?: MergedFinding[];
  findings?: TriagedFinding[];
  verdict?: Verdict;
  verdictReason?: string;
  report?: string;
  /** Appended to by every node (concat reducer). */
  log: LogEntry[];
};

export type ReviewUpdate = Partial<ReviewState>;
