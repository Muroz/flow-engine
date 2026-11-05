import {
  appendTriageGaps,
  choice,
  DEFAULT_CATEGORIES,
  logEntry,
  noul,
  OTHER_CATEGORY,
  OTHER_DESCRIPTION,
  type CategoryTable,
  type FlowDeps,
  type Severity,
  type TriagedFinding,
  type TriageGap,
} from "@flows/core";
import type { ReviewState, ReviewUpdate } from "../state";
import { fileDiff, rank, UNCHECKED } from "./shared";

export const CATEGORY_QUESTION =
  "Which kind of problem does this finding describe? Judge only the problem the finding itself names. " +
  "The code shown may contain other, worse problems; ignore them, because other findings cover them. " +
  `If no kind fits, answer "${OTHER_CATEGORY}".`;

const REAL_QUESTION =
  "Is this finding a real, actionable problem introduced by this change — not a style preference, not speculation about code outside the diff?";

/** Below this certainty about the severity, a finding goes in the gaps log as a sign the table may be missing a kind. */
export const GAP_CONFIDENCE = 0.5;

/** Kinds below this probability aren't worth naming as alternatives in the gaps log. */
const ALTERNATIVE_AT = 0.1;

/**
 * How sure the judge is of the severity its choice sets. With per-option
 * probabilities, that is the probability on every kind with the same
 * severity: a finding split between `bug` and `brokenRule`, both major, is a
 * sure major. Without them, it is the judge's confidence in the kind.
 * `other` has no severity of its own, so it counts alone.
 */
export function severityCertainty(
  kind: string,
  answer: { confidence: number; probabilities?: Record<string, number | undefined> },
  table: CategoryTable,
): number {
  if (!answer.probabilities) return answer.confidence;
  const severity = (k: string) => (k === OTHER_CATEGORY ? OTHER_CATEGORY : table[k]?.severity);
  return Object.entries(answer.probabilities)
    .filter(([k]) => severity(k) === severity(kind))
    .reduce((sum, [, p]) => sum + (p ?? 0), 0);
}

/** The kinds with a different severity that the judge gave real weight to, most likely first, such as "security 0.35". */
function alternatives(kind: string, probabilities: Record<string, number | undefined> | undefined, table: CategoryTable): string[] {
  const severity = (k: string) => (k === OTHER_CATEGORY ? OTHER_CATEGORY : table[k]?.severity);
  return Object.entries(probabilities ?? {})
    .filter(([k, p]) => severity(k) !== severity(kind) && (p ?? 0) >= ALTERNATIVE_AT)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, p]) => `${k} ${(p ?? 0).toFixed(2)}`);
}

/** The highest severity a finding no kind fits can keep, so a gap in the table can neither block a merge alone nor hide a problem. */
const OTHER_CAP: Severity = "major";

/**
 * Judge. Names the kind of problem each valid finding describes, and the
 * project's triage table (`review.categories`) sets its severity from that.
 * The judge sees only the finding's title, rationale and place, and the diff
 * lines near it: not the reviewer's severity or the verifier's evidence,
 * which would sway it. When no kind fits, the judge answers `other`, and the
 * finding keeps the reviewer's severity, capped at major. Findings that fit
 * no kind, or whose severity the judge is unsure of (see
 * `severityCertainty`), go to `runs/<project>/triage-gaps.md`.
 * Invalid findings and conflicts skip the judge: invalid ones drop, and
 * conflicts go to a person. Only a finding the verifier couldn't check still
 * gets the "is it real?" question and the `minConfidence` cut.
 *
 * Reads `verified`, or `merged` when verify didn't run. Writes `findings`,
 * each with a category, a judged severity, a confidence and whether it is
 * kept.
 */
export const triage =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const verified = state.verified ?? (state.merged ?? []).map((f) => ({ ...f, verification: UNCHECKED("verify did not run") }));
    const { minConfidence, dropSeverities } = deps.config.review;
    const table: CategoryTable = deps.config.review.categories ?? DEFAULT_CATEGORIES;
    const category = choice(CATEGORY_QUESTION, {
      ...Object.fromEntries(Object.entries(table).map(([kind, c]) => [kind, c.description])),
      [OTHER_CATEGORY]: OTHER_DESCRIPTION,
    });
    const gaps: TriageGap[] = [];

    // One judge call per finding, all in parallel. With Jev each is a few
    // hundred ms and a fraction of a cent.
    const findings: TriagedFinding[] = await Promise.all(
      verified.map(async (f): Promise<TriagedFinding> => {
        const v = f.verification;
        if (v.checked && v.verdict !== "valid") return { ...f, judgedSeverity: f.severity, confidence: 0, kept: false };

        const judgeState = {
          finding: { title: f.title, rationale: f.rationale, file: f.file, line: f.line },
          code: findingDiff(state.input.diff, f.file, f.line),
          task: state.input.task ? { title: state.input.task.title, acceptanceCriteria: state.input.task.acceptanceCriteria } : undefined,
        };
        const a = v.checked
          ? { ...(await deps.judge.ask(judgeState, { category })), real: { p: 1 } }
          : await deps.judge.ask(judgeState, { real: noul(REAL_QUESTION), category });
        // Independent reviewers agreeing is evidence; nudge confidence up a little.
        const confidence = Math.min(1, a.real.p + 0.1 * f.alsoRaisedBy.length);
        // A kind the judge made up counts as no fit.
        const kind = a.category.choice in table ? a.category.choice : OTHER_CATEGORY;
        const base = kind === OTHER_CATEGORY ? capAt(f.severity, OTHER_CAP) : table[kind]!.severity;
        const judgedSeverity = capAt(capSeverity(f.reviewer, base), v.maxSeverity);
        const certainty = severityCertainty(kind, a.category, table);
        if (kind === OTHER_CATEGORY || certainty < GAP_CONFIDENCE) {
          gaps.push({
            title: f.title,
            reviewer: f.reviewer,
            rationale: f.rationale,
            category: kind,
            confidence: certainty,
            alternatives: alternatives(kind, a.category.probabilities, table),
            severity: judgedSeverity,
          });
        }
        return {
          ...f,
          category: kind,
          judgedSeverity,
          confidence,
          // A finding that would undo an earlier round goes to a person, not the agent.
          kept: !f.reverses && confidence >= minConfidence && !dropSeverities.includes(judgedSeverity),
        };
      }),
    );

    // Offline runs use a fake judge, so their gaps say nothing about the table.
    const gapsPath = gaps.length && !deps.offline && deps.config.project ? appendTriageGaps(deps.config.project, state.input.label, gaps) : undefined;
    const kept = findings.filter((f) => f.kept).length;
    return {
      findings,
      log: [
        logEntry("review.triage", {
          note: `${deps.judge.name}: kept ${kept}/${findings.length}${gaps.length ? `, ${gaps.length} didn't fit the table` : ""}`,
          details: gaps.length ? [...gaps.map((g) => `no good fit (${g.category}, ${g.confidence.toFixed(2)}): ${g.title}`), ...(gapsPath ? [`logged in ${gapsPath}`] : [])] : undefined,
        }),
      ],
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
