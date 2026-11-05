import { loadPrompt, logEntry, modelFor, parseJsonReply, render, SEVERITIES, type Finding, type FlowDeps, type Severity } from "@flows/core";
import { laterRound, REVIEWERS, standardsFor } from "../reviewers";
import type { ReviewState, ReviewUpdate } from "../state";

/**
 * Generative, and the fan-out target. The graph sends one copy per
 * specialist, each with its own `currentReviewer`, and they run in parallel.
 * Each specialist sees only its slice of the context and reports only
 * problems within its responsibility.
 *
 * Reads `currentReviewer` and `context`. Writes `rawFindings`, which the
 * reducer concatenates across branches.
 */
export const reviewer =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const spec = REVIEWERS[state.currentReviewer ?? ""];
    if (!spec || !state.context) return {};

    const template = loadPrompt(spec.prompt);
    const user = render(template, {
      ...spec.view(state.context),
      standards: standardsFor(spec.id, state.context),
      output_format: laterRound(state.context, loadPrompt("review/_later_round")) + loadPrompt("review/_output"),
    });

    const res = await deps.model.complete({
      tag: `review.${spec.id}`,
      model: modelFor(deps.config, "reviewer"),
      json: true,
      system: "You are a senior code reviewer with one narrow responsibility. Only report problems within it.",
      user,
    });

    const parsed = parseJsonReply<{ findings?: any[] }>(res.text, { findings: [] });
    const findings: Finding[] = (parsed.findings ?? []).map((f) => ({
      reviewer: spec.id,
      title: String(f.title ?? "Untitled finding"),
      file: f.file ? String(f.file) : undefined,
      line: Number.isFinite(Number(f.line)) ? Number(f.line) : undefined,
      severity: asSeverity(f.severity),
      rationale: String(f.rationale ?? ""),
      suggestion: f.suggestion ? String(f.suggestion) : undefined,
      reverses: f.reverses ? String(f.reverses) : undefined,
    }));

    return {
      rawFindings: findings,
      log: [logEntry(`review.${spec.id}`, { model: res.model, costUsd: res.costUsd, note: `${findings.length} findings` })],
    };
  };

/** A severity the model made up becomes `minor`. */
function asSeverity(x: unknown): Severity {
  return SEVERITIES.includes(x as Severity) ? (x as Severity) : "minor";
}
