/**
 * Specialist reviewers.
 *
 * The important part is `view`: each specialist gets a *narrow* slice of the
 * context, rendered into its prompt. The security reviewer never sees the
 * PRD; the spec reviewer never sees the ADRs. Smaller context → sharper
 * reviews, lower cost, and fewer "while I'm here…" tangents.
 *
 * To add a reviewer: add an entry here, add prompts/review/<id>.md, and list
 * the id under `review.reviewers` in .flows.yaml.
 */
import type { ReviewContext } from "./state";

export type ReviewerSpec = {
  id: string;
  /** Prompt file under prompts/, e.g. "review/security". */
  prompt: string;
  /** Skip this reviewer when it has nothing to check against. */
  appliesTo?: (ctx: ReviewContext) => boolean;
  /** The slice of context this reviewer is allowed to see. */
  view: (ctx: ReviewContext) => Record<string, string>;
};

const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "(none)");

export const REVIEWERS: Record<string, ReviewerSpec> = {
  spec: {
    id: "spec",
    prompt: "review/spec",
    appliesTo: (ctx) => !!ctx.task && ctx.task.acceptanceCriteria.length > 0,
    view: (ctx) => ({
      task_title: `${ctx.task!.id}: ${ctx.task!.title}`,
      acceptance_criteria: bullets(ctx.task!.acceptanceCriteria),
      diff: ctx.diff,
    }),
  },

  correctness: {
    id: "correctness",
    prompt: "review/correctness",
    view: (ctx) => ({ diff: ctx.diff }),
  },

  security: {
    id: "security",
    prompt: "review/security",
    view: (ctx) => ({ diff: ctx.diff }),
  },

  tests: {
    id: "tests",
    prompt: "review/tests",
    view: (ctx) => ({
      changed_files: bullets(ctx.files),
      acceptance_criteria: bullets(ctx.task?.acceptanceCriteria ?? []),
      diff: ctx.diff,
    }),
  },

  architecture: {
    id: "architecture",
    prompt: "review/architecture",
    appliesTo: (ctx) => ctx.adrs.length > 0 || ctx.conventions.length > 0,
    view: (ctx) => ({
      decisions: ctx.adrs.length
        ? ctx.adrs.map((a) => `### ${a.id}: ${a.title}\n${a.decision}`).join("\n\n")
        : "(none)",
      conventions: bullets(ctx.conventions),
      diff: ctx.diff,
    }),
  },
};

/** Reviewers enabled in config that apply to this context. */
export function activeReviewers(ids: string[], ctx: ReviewContext): ReviewerSpec[] {
  return ids
    .map((id) => REVIEWERS[id])
    .filter((r): r is ReviewerSpec => !!r && (r.appliesTo?.(ctx) ?? true));
}
