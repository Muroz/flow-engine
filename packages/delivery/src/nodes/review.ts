import { logEntry, runDir, writeRunFile, type FlowDeps, type PriorFinding, type TriagedFinding } from "@flows/core";
import { conflictWith, isConflict, rank, type ReviewGraph, type ReviewState } from "@flows/review";
import { treeDiff } from "../agents/claude-code";
import type { DeliveryState, DeliveryUpdate } from "../state";
import { roundOf } from "./shared";

/** A review finding as a note for the agent, with the reviewer's reason. */
export function findingNote(f: TriagedFinding): string {
  const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  const why = f.rationale ? `: ${f.rationale.split(/(?<=\.)\s/)[0]}` : "";
  return `[${f.judgedSeverity}] ${f.title}${where}${why}`;
}

/**
 * The review flow runs as a subgraph. The mapping in and out is explicit on
 * purpose: review sees the diff, the task and what earlier rounds asked for
 * (the ledger and what changed since) — not the plan or the checks output.
 * Delivery gets back the verdict, the findings to fix and the conflicts to
 * put to you. The graph names this node `runReview`, because `review` is also
 * a state key.
 *
 * Reads `diff`, `task`, `ledger`, `workdir` and the tree snapshots. Writes
 * `review`, `fixNotes`, `reviewedTree` and `ledger` entries for this round.
 */
export const review =
  (deps: FlowDeps, reviewGraph: ReviewGraph) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const round = roundOf(s);
    const ledger = s.ledger ?? [];
    const delta = ledger.length && s.workdir && s.reviewedTree && s.tree ? treeDiff(s.workdir, s.reviewedTree, s.tree) : undefined;
    const out = (await reviewGraph.invoke({
      input: { diff: s.diff ?? "", task: s.task, label: `${s.task.id} round ${round}`, prior: ledger, delta, workdir: s.workdir },
    })) as ReviewState;

    const all = out.findings ?? [];
    const kept = all.filter((f) => f.kept).sort((a, b) => rank(b.judgedSeverity) - rank(a.judgedSeverity));
    const conflicts = all.filter((f) => !f.kept && isConflict(f));
    const reportPath = writeRunFile(runDir(deps.config, s.runId), `review-${round}.md`, out.report ?? "");
    return {
      review: { verdict: out.verdict ?? "escalate", reason: out.verdictReason ?? "", findings: kept, conflicts, report: out.report ?? "", reportPath },
      fixNotes: kept.map(findingNote),
      reviewedTree: s.tree,
      ledger: [
        ...kept.map((f) => toPrior(f, round, "sent")),
        ...conflicts.map((f) => ({ ...toPrior(f, round, "escalated"), note: `conflicts with ${conflictWith(f)}` })),
      ],
      log: [
        ...out.log,
        logEntry("delivery.review", {
          note: `${out.verdict}: ${out.verdictReason}`,
          details: [
            ...kept.map((f) => `[${f.judgedSeverity}] ${f.title}${f.file ? ` (${f.file})` : ""}`),
            ...conflicts.map((f) => `conflict: ${f.title} vs ${conflictWith(f)}`),
          ],
        }),
      ],
    };
  };

/** A finding as a ledger entry, so later rounds know what was asked and what happened to it. */
const toPrior = (f: TriagedFinding, round: number, status: PriorFinding["status"]): PriorFinding => ({
  round,
  reviewer: f.reviewer,
  severity: f.judgedSeverity,
  title: f.title,
  file: f.file,
  rationale: f.rationale.split(/(?<=\.)\s/)[0] ?? "",
  status,
});

/** Findings still open from any round: the ones the agent declined and the conflicts left for you, latest per title. */
export function openItems(ledger: PriorFinding[]): string[] {
  const latest = new Map<string, PriorFinding>();
  for (const p of ledger) latest.set(p.title, p);
  return [...latest.values()]
    .filter((p) => p.status !== "sent")
    .map((p) => `round ${p.round}, ${p.status === "declined" ? "declined by the agent" : "conflict"}: ${p.title}${p.note ? ` (${p.note})` : ""}`);
}
