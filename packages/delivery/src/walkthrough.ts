/**
 * Plain-language walkthroughs of finished work, and the project journal that
 * links them. Both live under `runs/`: they help you follow the work and are
 * not project documentation.
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  changedFiles,
  filterDiff,
  reviewIgnore,
  ENGINE_ROOT,
  loadPrompt,
  logEntry,
  modelFor,
  render,
  writingRules,
  runDir,
  writeRunFile,
  type FlowDeps,
  type LogEntry,
  type PlannedTask,
} from "@flows/core";

export type WalkthroughInput = {
  task: PlannedTask;
  diff: string;
  runId: string;
  plan?: { summary: string; steps: string[] };
  review?: { verdict: string; reason: string };
};

/** `howItWorks` is missing on runs saved before the merge gate showed it. */
export type Walkthrough = { path: string; gist: string; howItWorks?: string };

/** Diffs past this size are cut, so one huge generated file can't crowd out the rest. */
const MAX_DIFF_CHARS = 60_000;
const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "(none)");

export async function writeWalkthrough(deps: FlowDeps, input: WalkthroughInput): Promise<{ walkthrough: Walkthrough; log: LogEntry }> {
  const { task, plan, review } = input;
  const { diff, skipped } = filterDiff(input.diff, reviewIgnore(deps.config));
  const res = await deps.model.complete({
    tag: "delivery.walkthrough",
    model: modelFor(deps.config, "planner"),
    system: "You explain software changes to people who don't read code.",
    user: render(loadPrompt("delivery/walkthrough"), {
      writing_rules: writingRules("owner"),
      task: `${task.id}: ${task.title}`,
      acceptance_criteria: bullets(task.acceptanceCriteria),
      plan: plan ? `${plan.summary}\n${bullets(plan.steps)}` : "(no plan recorded)",
      review: review ? `${review.verdict}: ${review.reason}` : "(not reviewed)",
      files: bullets([...changedFiles(diff), ...skipped.map((f) => `${f} (generated, not shown)`)]),
      diff: diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut at ${MAX_DIFF_CHARS} characters]` : diff,
    }),
  });

  const body = res.text.trim();
  const path = writeRunFile(runDir(deps.config, input.runId), "walkthrough.md", `# ${task.id}: ${task.title}\n\n${body}\n`);
  return {
    walkthrough: { path, gist: gistOf(body), howItWorks: howItWorksOf(body) },
    log: logEntry("delivery.walkthrough", { model: res.model, costUsd: res.costUsd }),
  };
}

/** The "In short" section, or the first paragraph when the model left it out. */
export function gistOf(markdown: string): string {
  const text = sectionOf(markdown, "In short") ?? markdown.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith("#")) ?? "";
  return text.trim();
}

/**
 * The "How it works" section for the merge gate. A terminal can't draw a
 * Mermaid diagram, so each one becomes a pointer to the full text.
 */
export function howItWorksOf(markdown: string): string | undefined {
  const text = sectionOf(markdown, "How it works");
  return text?.replace(/```mermaid[\s\S]*?```/g, "(Diagram in the full text.)").trim() || undefined;
}

/** The body of one `## heading` section, up to the next one. */
function sectionOf(markdown: string, heading: string): string | undefined {
  return markdown.match(new RegExp(`^##\\s*${heading}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, "im"))?.[1];
}

/** Adds a merged task to `runs/<project>/journal.md`, newest last. */
export function appendJournal(deps: FlowDeps, task: PlannedTask, walkthrough: Walkthrough, runId: string): string {
  const path = join(ENGINE_ROOT, "runs", deps.config.project, "journal.md");
  const header = existsSync(path) ? "" : `# ${deps.config.project} journal\n\nOne entry per merged task. Each links to its full walkthrough.\n`;
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(path, `${header}\n## ${task.id}: ${task.title} (${date})\n\n${walkthrough.gist}\n\n[Walkthrough](${runId}/walkthrough.md)\n`);
  return path;
}
