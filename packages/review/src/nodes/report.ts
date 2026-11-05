import { totalCost, type TriagedFinding } from "@flows/core";
import type { ReviewState, ReviewUpdate } from "../state";
import { conflictWith, isConflict, isInvalid } from "./decide";
import { rank } from "./shared";

/**
 * Deterministic. The one-screen Markdown digest for you: the verdict, a table
 * of kept findings, conflicts for you to decide, findings verification
 * dropped, and which node did what at what cost. The graph names this node
 * `writeReport`, because `report` is also a state key.
 *
 * Reads `findings`, `verdict`, `verdictReason` and `log`. Writes `report`.
 */
export const report = async (state: ReviewState): Promise<ReviewUpdate> => {
  const findings = state.findings ?? [];
  const kept = findings.filter((f) => f.kept).sort((a, b) => rank(b.judgedSeverity) - rank(a.judgedSeverity));
  const dropped = findings.length - kept.length;
  const icon = { pass: "✅", fix: "🔧", escalate: "🙋" }[state.verdict ?? "pass"];

  const rows = kept.map(
    (f) =>
      `| ${f.judgedSeverity} | ${f.title} | ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "—"} | ${[f.reviewer, ...(f.alsoRaisedBy ?? [])].join(", ")} | ${f.confidence.toFixed(2)} |`,
  );

  const conflicts = findings.filter(isConflict);
  const invalid = findings.filter(isInvalid);
  const where = (f: TriagedFinding) => (f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "");

  const md = [
    `# Review — ${state.input.label}`,
    "",
    `**Verdict:** ${icon} ${state.verdict} — ${state.verdictReason}`,
    "",
    kept.length
      ? ["| Severity | Finding | Where | Raised by | Confidence |", "|---|---|---|---|---|", ...rows].join("\n")
      : "_No findings worth your time._",
    "",
    dropped - conflicts.length - invalid.length > 0
      ? `<sub>${dropped - conflicts.length - invalid.length} low-value finding(s) filtered by the judge.</sub>`
      : "",
    "",
    "## Details",
    ...kept.map((f) => `### ${f.title}\n${f.rationale}${f.suggestion ? `\n\n**Suggestion:** ${f.suggestion}` : ""}`),
    "",
    ...(conflicts.length
      ? [
          "## Conflicts for you to decide",
          "These would undo a rule or an earlier round's change, so they didn't go to the agent.",
          "",
          ...conflicts.map((f) => `- **${f.title}**${where(f)} from ${f.reviewer}, against ${conflictWith(f)}. ${f.verification?.evidence ?? ""}`.trim()),
          "",
        ]
      : []),
    ...(invalid.length
      ? [
          "## Dropped by verification",
          ...invalid.map((f) => `- **${f.title}**${where(f)} from ${f.reviewer}: ${f.verification!.evidence}`),
          "",
        ]
      : []),
    "## Provenance",
    ...state.log.map((e) => `- \`${e.node}\`${e.model ? ` (${e.model})` : ""}${e.note ? ` — ${e.note}` : ""}`),
    `- total model cost: $${totalCost(state.log).toFixed(4)}`,
  ].join("\n");

  return { report: md };
};
