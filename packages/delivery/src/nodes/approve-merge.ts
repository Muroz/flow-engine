import { logEntry, totalCost, type FlowDeps } from "@flows/core";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { mergeWorktree } from "../agents/claude-code";
import type { DeliveryState, DeliveryUpdate } from "../state";
import { appendJournal } from "../walkthrough";
import { findingNote, openItems } from "./review";
import { describeCheck } from "./run-checks";
import { gate, roundOf, say } from "./shared";

/**
 * Which open comments a "fix" at the merge gate sends back. No notes: all of
 * them. Leading numbers, such as "1,3: also rename the helper": those, plus
 * the text. Text alone: just the text.
 */
export function pickComments(comments: string[], notes: string | undefined): string[] {
  const text = (notes ?? "").trim();
  if (!text) return comments;
  const m = text.match(/^([\d,\s]+)(?::\s*([\s\S]*))?$/) ?? text.match(/^([\d,\s]+):\s*([\s\S]*)$/);
  if (!m) return [text];
  const picked = m[1]!.split(/[,\s]+/).filter(Boolean).map((n) => comments[Number(n) - 1]).filter((c): c is string => !!c);
  return m[2]?.trim() ? [...picked, m[2].trim()] : picked;
}

/**
 * Human gate, always open at the end. merge commits the worktree on
 * flows/<task>, fast-forwards the base to it and adds the walkthrough to the
 * journal; fix sends the review comments you pick back to the agent for
 * `delivery.retryAttempts` more attempts; reject ends the run.
 *
 * Reads `walkthrough`, `review`, `checks`, `ledger`, `workdir` and `log`.
 * Writes `outcome`, or `attempts`, `budgetFrom` and `fixNotes` on a fix.
 */
export const approveMerge =
  (deps: FlowDeps) =>
  async (s: DeliveryState, config?: LangGraphRunnableConfig): Promise<DeliveryUpdate> => {
    const comments = (s.review?.findings ?? []).map(findingNote);
    const d = gate({
      gate: "approve-merge",
      title: `Merge ${s.task.id}?`,
      detailPath: s.walkthrough?.path,
      summary: [
        ...(s.walkthrough?.gist ? [s.walkthrough.gist, ""] : []),
        ...(s.walkthrough?.howItWorks ? ["How it works:", "", s.walkthrough.howItWorks, ""] : []),
        `${s.task.title}: ${roundOf(s)} round(s), $${totalCost(s.log).toFixed(2)} in model calls`,
        `Checks: ${s.checks?.results.length ? s.checks.results.map(describeCheck).join("  ") : s.checks ? "skipped" : "not run"}`,
        `Review: ${s.review?.verdict ?? "not run"} (${s.review?.reason ?? ""})`,
        ...(s.workdir ? [`Branch: flows/${s.task.id} in ${s.workdir}`] : []),
        ...(comments.length ? ["", "Open review comments:", ...comments.map((c, i) => `  ${i + 1}. ${c}`)] : []),
        ...(openItems(s.ledger ?? []).length ? ["", "Declined or in conflict, from any round:", ...openItems(s.ledger ?? []).map((o) => `  ${o}`)] : []),
        ...(comments.length
          ? ["", `fix sends comments back for ${deps.config.delivery.retryAttempts} more attempt(s): no notes for all, "1,3" for some, or your own text.`]
          : []),
      ].join("\n"),
      options: comments.length ? ["merge", "fix", "reject"] : ["merge", "reject"],
    });
    if (d.decision === "fix") {
      return {
        attempts: Math.max(0, deps.config.delivery.maxAttempts - deps.config.delivery.retryAttempts),
        budgetFrom: totalCost(s.log),
        fixNotes: pickComments(comments, d.notes),
        walkthrough: undefined,
        log: [logEntry("delivery.approveMerge", { note: "fix" })],
      };
    }
    // merge commits the worktree on flows/<task> and fast-forwards the base to
    // it. Pushing stays with you (see docs/wiring.md, step 5).
    const merged = d.decision === "merge";
    const notes = [d.decision];
    let landed = merged && !deps.offline;
    if (landed && s.workdir) {
      const r = mergeWorktree(deps.config.repoDir, s.workdir, s.task.id, s.base, `${s.task.id}: ${s.task.title}`);
      landed = r.merged;
      const line = r.merged
        ? `committed ${r.commit?.slice(0, 7)} on flows/${s.task.id} and merged it into ${s.base}`
        : `${r.commit ? `committed ${r.commit.slice(0, 7)} on flows/${s.task.id}, but ` : ""}not merged into ${s.base}: ${r.why}. ` +
          `Finish with: git -C ${deps.config.repoDir} merge flows/${s.task.id}`;
      say(config, `      ${line}`);
      notes.push(line);
    }
    const journal = landed && s.walkthrough ? appendJournal(deps, s.task, s.walkthrough, s.runId) : undefined;
    if (journal) notes.push("journal updated");
    return {
      outcome: merged ? "merged" : "rejected",
      log: [logEntry("delivery.approveMerge", { note: notes.join(", ") })],
    };
  };
