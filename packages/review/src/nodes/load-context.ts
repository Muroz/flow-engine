import { changedFiles, filterDiff, loadAdrs, loadStandards, logEntry, reviewIgnore, type FlowDeps } from "@flows/core";
import type { ReviewState, ReviewUpdate } from "../state";

/**
 * Deterministic. Gathers what every reviewer needs: the diff with generated
 * files left out, the task, the ADRs it cites and all the others, the
 * standards and conventions, and findings from earlier rounds.
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
    const { task, prior = [], delta } = state.input;
    const adrs = loadAdrs(deps.config, task?.adrRefs);
    const allAdrs = loadAdrs(deps.config);
    const files = changedFiles(diff);
    const standards = loadStandards(deps.config);
    return {
      context: { diff, files, skipped, task, adrs, allAdrs, conventions: deps.config.conventions, standards, prior, delta },
      log: [
        logEntry("review.loadContext", {
          note: `${files.length} files, ${adrs.length} ADRs, ${standards.length} standards, ${Math.round(diff.length / 1000)}k characters`,
          details: skipped.length ? [`not reviewed (generated): ${skipped.join(", ")}`] : undefined,
        }),
      ],
    };
  };
