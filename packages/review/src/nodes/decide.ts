import { logEntry, type FlowDeps, type Severity, type TriagedFinding } from "@flows/core";
import type { ReviewState, ReviewUpdate } from "../state";
import { rank } from "./shared";

/**
 * Deterministic, and deliberately plain code. The judge already answered the
 * fuzzy questions; turning those answers into a verdict is policy, and
 * policy belongs in code you can read, test and change.
 *
 * Reads `findings`. Writes `verdict` and `verdictReason`.
 */
export const decide =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const { verdict, reason } = decideVerdict(state.findings ?? [], deps.config.review);
    return { verdict, verdictReason: reason, log: [logEntry("review.decide", { note: `${verdict}: ${reason}` })] };
  };

/**
 * The verdict and a one-line reason. Conflicts escalate first, then serious
 * findings the judge isn't sure about. Kept major or blocker findings mean
 * fix; anything else passes.
 */
export function decideVerdict(
  findings: TriagedFinding[],
  policy: { minConfidence: number; escalateAtSeverity: Severity },
): { verdict: "pass" | "fix" | "escalate"; reason: string } {
  // Two rules, or two rounds, pull opposite ways. Fixing either side would
  // only bring the other back next round, so a person decides once.
  const conflicts = findings.filter(isConflict);
  if (conflicts.length) {
    return { verdict: "escalate", reason: `reviewers disagree: ${conflicts.map((f) => `"${f.title}" vs ${conflictWith(f)}`).join("; ")}` };
  }

  // Serious but uncertain → a human should look. Findings the verifier ruled out aren't uncertain.
  const unsure = findings.filter(
    (f) =>
      !isRuledOut(f) && rank(f.judgedSeverity) >= rank(policy.escalateAtSeverity) && f.confidence < policy.minConfidence,
  );
  if (unsure.length) return { verdict: "escalate", reason: `${unsure.length} serious finding(s) the judge isn't sure about` };

  const mustFix = findings.filter((f) => f.kept && rank(f.judgedSeverity) >= rank("major"));
  if (mustFix.length) return { verdict: "fix", reason: `${mustFix.length} major/blocker finding(s)` };

  const minors = findings.filter((f) => f.kept).length;
  return { verdict: "pass", reason: minors ? `${minors} minor comment(s), nothing blocking` : "no findings" };
}

/** The verifier found a clash with a rule or earlier round, or the reviewer said it would undo one. */
export const isConflict = (f: TriagedFinding) =>
  (f.verification?.checked && f.verification.verdict === "conflict") || (!!f.reverses && !isRuledOut(f));

/** The verifier showed the finding is wrong. */
export const isInvalid = (f: TriagedFinding) => !!f.verification?.checked && f.verification.verdict === "invalid";

/** The verifier checked the finding and found it invalid or in conflict. */
const isRuledOut = (f: TriagedFinding) => !!f.verification?.checked && f.verification.verdict !== "valid";

/** What a conflicting finding clashes with: the rule the verifier named, or the earlier request it would undo. */
export const conflictWith = (f: TriagedFinding) =>
  f.verification?.verdict === "conflict" ? (f.verification.conflictsWith ?? "a rule") : `an earlier request ("${f.reverses}")`;
