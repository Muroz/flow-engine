import { logEntry, type Finding } from "@flows/core";
import type { MergedFinding, ReviewState, ReviewUpdate } from "../state";
import { rank } from "./shared";

/**
 * Deterministic. Merges the findings several specialists raised about the
 * same problem.
 *
 * Reads `rawFindings`. Writes `merged`.
 */
export const aggregate = async (state: ReviewState): Promise<ReviewUpdate> => {
  const merged = dedupeFindings(state.rawFindings);
  return {
    merged,
    log: [logEntry("review.aggregate", { note: `${state.rawFindings.length} → ${merged.length} after dedupe` })],
  };
};

/**
 * Two findings are "the same" when they point at the same file, within a few
 * lines, and their titles overlap. The survivor keeps the higher severity and
 * remembers who else raised it — agreement is a useful signal for triage.
 */
export function dedupeFindings(findings: Finding[]): MergedFinding[] {
  const out: MergedFinding[] = [];
  for (const f of findings) {
    const twin = out.find(
      (m) =>
        m.file === f.file &&
        (m.line === undefined || f.line === undefined || Math.abs(m.line - f.line) <= 3) &&
        titleOverlap(m.title, f.title) >= 0.3,
    );
    if (!twin) {
      out.push({ ...f, alsoRaisedBy: [] });
      continue;
    }
    if (twin.reviewer !== f.reviewer && !twin.alsoRaisedBy.includes(f.reviewer)) twin.alsoRaisedBy.push(f.reviewer);
    if (rank(f.severity) > rank(twin.severity)) twin.severity = f.severity;
  }
  return out;
}

/** Shared words longer than three letters, as a share of all such words in either title. */
function titleOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size;
}
