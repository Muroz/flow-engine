import { changedFiles, filterDiff, loadAdrs, loadStandards, logEntry, reviewIgnore, type FlowDeps } from "@flows/core";
import { REVIEWERS, roundScope } from "../reviewers";
import type { ReviewContext, ReviewState, ReviewUpdate } from "../state";

/**
 * Deterministic. Gathers what every reviewer needs: the diff with generated
 * files left out, the task, the ADRs it cites and all the others, the
 * standards and conventions, findings from earlier rounds and what changed
 * since the last one, with generated files left out of both diffs.
 *
 * Reads `input`. Writes `context`.
 */
export const loadContext =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const filtered = filterDiff(state.input.diff, reviewIgnore(deps.config));
    const { skipped } = filtered;
    // Say what was left out, or reviewers report those files as missing.
    const diff = skipped.length
      ? `Generated files this change also adds or edits, left out to save space: ${skipped.join(", ")}\n\n${filtered.diff}`
      : filtered.diff;
    const { task, prior = [] } = state.input;
    const delta = state.input.delta === undefined ? undefined : filterDiff(state.input.delta, reviewIgnore(deps.config)).diff;
    const adrs = loadAdrs(deps.config, task?.adrRefs);
    const allAdrs = loadAdrs(deps.config);
    const files = changedFiles(diff);
    const standards = loadStandards(deps.config);
    const context: ReviewContext = { diff, files, skipped, task, adrs, allAdrs, conventions: deps.config.conventions, standards, prior, delta };
    const scope = deps.config.review.laterRounds === "changed" ? roundScope(context) : undefined;
    const skippedReviewers = scope ? Object.keys(REVIEWERS).filter((id) => !scope.reviewers.has(id)) : [];
    return {
      context,
      log: [
        logEntry("review.loadContext", {
          note:
            `${files.length} files, ${adrs.length} ADRs, ${standards.length} standards, ${Math.round(diff.length / 1000)}k characters` +
            (skippedReviewers.length ? `; this round changed ${scope!.kinds.join(", ") || "nothing"}, so ${skippedReviewers.join(", ")} sat out` : ""),
          details: skipped.length ? [`not reviewed (generated): ${skipped.join(", ")}`] : undefined,
        }),
      ],
    };
  };
