import { logEntry, noul, score, SEVERITIES, type FlowDeps, type Severity, type TriagedFinding } from "@flows/core";
import type { ReviewState, ReviewUpdate } from "../state";
import { fileDiff, rank, UNCHECKED } from "./shared";

/** The same scale the reviewers use (prompts/review/_output.md), so the judge doesn't invent its own. */
export const SEVERITY_QUESTION =
  "How severe is the problem if merged as-is? blocker: a security hole in code that runs, data loss, or a broken build. " +
  "major: a bug in code that runs, a missed acceptance criterion, or a broken ADR or project standard. " +
  "minor: hardening beyond what the task asks, unusual ways around a rule, or unclear docs. nit: taste. " +
  "If neither the task nor an ADR nor a project standard asks for it, it is minor at most. " +
  "Docs and comments are minor at most. " +
  "Asking the change to build something a later task will build, rather than fixing something it contradicts, is minor at most.";

const REAL_QUESTION =
  "Is this finding a real, actionable problem introduced by this change — not a style preference, not speculation about code outside the diff?";

/**
 * Judge. Rates how severe each valid finding is. Invalid findings and
 * conflicts skip it: invalid ones drop, and conflicts go to a person. Only a
 * finding the verifier couldn't check still gets the judge's "is it real?"
 * question and the `minConfidence` cut.
 *
 * Reads `verified`, or `merged` when verify didn't run. Writes `findings`,
 * each with a judged severity, a confidence and whether it is kept.
 */
export const triage =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const verified = state.verified ?? (state.merged ?? []).map((f) => ({ ...f, verification: UNCHECKED("verify did not run") }));
    const { minConfidence, dropSeverities } = deps.config.review;

    // One judge call per finding, all in parallel. With Jev each is a few
    // hundred ms and a fraction of a cent.
    const findings: TriagedFinding[] = await Promise.all(
      verified.map(async (f): Promise<TriagedFinding> => {
        const v = f.verification;
        if (v.checked && v.verdict !== "valid") return { ...f, judgedSeverity: f.severity, confidence: 0, kept: false };

        const judgeState = {
          finding: f,
          code: findingDiff(state.input.diff, f.file, f.line),
          task: state.input.task ? { title: state.input.task.title, acceptanceCriteria: state.input.task.acceptanceCriteria } : undefined,
        };
        const severity = score(SEVERITY_QUESTION, SEVERITIES);
        const a = v.checked
          ? { ...(await deps.judge.ask(judgeState, { severity })), real: { p: 1 } }
          : await deps.judge.ask(judgeState, { real: noul(REAL_QUESTION), severity });
        // Independent reviewers agreeing is evidence; nudge confidence up a little.
        const confidence = Math.min(1, a.real.p + 0.1 * f.alsoRaisedBy.length);
        const judgedSeverity = capAt(capSeverity(f.reviewer, a.severity.level), v.maxSeverity);
        return {
          ...f,
          judgedSeverity,
          confidence,
          // A finding that would undo an earlier round goes to a person, not the agent.
          kept: !f.reverses && confidence >= minConfidence && !dropSeverities.includes(judgedSeverity),
        };
      }),
    );

    const kept = findings.filter((f) => f.kept).length;
    return {
      findings,
      log: [logEntry("review.triage", { note: `${deps.judge.name}: kept ${kept}/${findings.length}` })],
    };
  };

const capAt = (severity: Severity, cap?: Severity): Severity => (cap && rank(severity) > rank(cap) ? cap : severity);

/**
 * Policy, not judgement: some reviewers can never block a merge. Docs
 * findings stop at minor; wrong instructions that matter show up in the
 * correctness or spec review too.
 */
export const SEVERITY_CAP: Record<string, Severity> = { docs: "minor" };

/** The severity, lowered to the reviewer's cap in `SEVERITY_CAP` when it has one. */
export function capSeverity(reviewer: string, severity: Severity): Severity {
  return capAt(severity, SEVERITY_CAP[reviewer]);
}

/**
 * The diff lines within `radius` lines of the finding, under the file's
 * headers. Reviewers' line numbers drift by a line or two, so 5 leaves room. Rating severity needs the problem, not its neighbours: given the
 * whole file, the judge rated a missing test as a blocker because a leaked
 * secret sat a few lines away. Without a line, or when the line isn't in
 * the diff, it falls back to the whole file's diff.
 */
export function findingDiff(diff: string, file: string | undefined, line: number | undefined, radius = 5): string {
  const whole = fileDiff(diff, file);
  if (!file || !line) return whole;
  const out: string[] = [];
  let next = 0; // the new-file line number of the next added or context line
  let inHunk = false;
  let kept = 0;
  for (const text of whole.split("\n")) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      out.push(text);
      continue;
    }
    if (!inHunk) {
      out.push(text); // file headers
      continue;
    }
    // A removed line sits where the next new line would go.
    const at = next;
    if (!text.startsWith("-") && !text.startsWith("\\")) next++;
    if (Math.abs(at - line) <= radius) {
      out.push(text);
      kept++;
    }
  }
  return kept ? out.join("\n") : whole;
}
