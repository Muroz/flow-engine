/**
 * Specialist reviewers.
 *
 * The important part is `view`: each specialist gets a *narrow* slice of the
 * context, rendered into its prompt. The security reviewer never sees the
 * PRD, but it does see the task's ADRs, where the trust model lives. The
 * spec reviewer sees only the ADRs its criteria name. Smaller context means
 * sharper reviews, lower cost and fewer "while I'm here" tangents.
 *
 * To add a reviewer: add an entry here, add prompts/review/<id>.md, and list
 * the id under `review.reviewers` in .flows.yaml.
 */
import { adrBrief, render, splitDiff, writingRules, type AdrRef, type PlannedTask, type PriorFinding } from "@flows/core";
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
      task_scope: taskScope(ctx.task),
      acceptance_criteria: bullets(ctx.task!.acceptanceCriteria),
      decisions: decisionsText(adrsNamedIn(ctx.task!.acceptanceCriteria, ctx.allAdrs)),
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
    view: (ctx) => ({ task_scope: taskScope(ctx.task), decisions: decisionsText(ctx.adrs), diff: ctx.diff }),
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
    appliesTo: (ctx) => ctx.adrs.length > 0 || ctx.conventions.length > 0 || ctx.standards.some((s) => s.reviewers.includes("architecture")),
    view: (ctx) => ({
      decisions: decisionsText(ctx.adrs),
      conventions: bullets(ctx.conventions),
      diff: ctx.diff,
    }),
  },

  docs: {
    id: "docs",
    prompt: "review/docs",
    appliesTo: (ctx) => touchesDocs(ctx),
    view: (ctx) => ({ writing_rules: writingRules("developer"), diff: docsDiff(ctx.diff) }),
  },
};

/** Each ADR by clause, so a finding can cite "ADR-0001 clause 3". */
export const decisionsText = (adrs: AdrRef[]) => (adrs.length ? adrs.map((a) => `### ${adrBrief(a)}`).join("\n\n") : "(none)");

/** The task's description and what it leaves out, or "(no task)" for a bare diff. */
export function taskScope(task: PlannedTask | undefined): string {
  if (!task) return "(no task: judge the diff on its own)";
  return [
    `${task.id}: ${task.title}`,
    task.description ?? "",
    `Out of scope:\n${bullets(task.outOfScope ?? [])}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The ADRs that acceptance criteria mention by ID, such as "as ADR-0006 scopes it" or "ADR-0001 clause 3". */
export function adrsNamedIn(criteria: string[], adrs: AdrRef[]): AdrRef[] {
  const named = new Set(criteria.join("\n").match(/ADR-\d{4}/g) ?? []);
  return adrs.filter((a) => named.has(a.id));
}

/** Earlier rounds' findings, one line each, for reviewers and the verifier. */
export function priorText(prior: PriorFinding[]): string {
  if (!prior.length) return "(none)";
  return prior
    .map((p) => {
      const where = p.file ? ` (${p.file})` : "";
      const note = p.note ? ` Note: ${p.note}` : "";
      return `- round ${p.round}, ${p.status}: [${p.severity}] ${p.title}${where}, from ${p.reviewer}. ${p.rationale}${note}`;
    })
    .join("\n");
}

/** The later-round rules, or nothing on a first round. */
export function laterRound(ctx: ReviewContext, template: string): string {
  if (!ctx.prior.length) return "";
  return render(template, { prior: priorText(ctx.prior), delta: ctx.delta?.trim() || "(the agent changed nothing since the last round)" }) + "\n";
}

const DOC_FILE = /\.(md|mdx|txt|rst)$/i;
const ADDED_COMMENT = /^\+(?!\+\+)\s*(\/\/|\/\*|\*|#(?!!))/m;

/** Doc files in full, and from code files only the hunks that add a comment. */
export function docsDiff(diff: string): string {
  return splitDiff(diff)
    .map(({ file, text }) => {
      if (DOC_FILE.test(file)) return text;
      const [header, ...hunks] = text.split(/^(?=@@ )/m);
      const commented = hunks.filter((h) => ADDED_COMMENT.test(h));
      return commented.length ? header + commented.join("") : "";
    })
    .join("");
}

/** Runs when the diff changes a doc file or adds a comment line. */
export function touchesDocs(ctx: ReviewContext): boolean {
  return ctx.files.some((f) => DOC_FILE.test(f)) || ADDED_COMMENT.test(ctx.diff);
}

/** The standards listed for one reviewer, ready for its prompt. A broken standard counts as major. */
export function standardsFor(reviewerId: string, ctx: ReviewContext): string {
  const mine = ctx.standards.filter((s) => s.reviewers.includes(reviewerId));
  if (!mine.length) return "(none)";
  return [
    "The project's own rules. A change that breaks one is a major finding; cite the file.",
    ...mine.map((s) => `### ${s.path}\n${s.text.trim()}`),
  ].join("\n\n");
}

/**
 * Reviewers enabled in config that apply to this context. With
 * `laterRounds: "changed"`, a later round keeps only the ones `roundScope`
 * picks.
 */
export function activeReviewers(ids: string[], ctx: ReviewContext, laterRounds: "changed" | "all" = "all"): ReviewerSpec[] {
  const scope = laterRounds === "changed" ? roundScope(ctx) : undefined;
  return ids
    .map((id) => REVIEWERS[id])
    .filter((r): r is ReviewerSpec => !!r && (r.appliesTo?.(ctx) ?? true) && (!scope || scope.reviewers.has(r.id)));
}

/** What a later round changed, by the reviewer whose area it is. */
export type ChangeKind = "code" | "tests" | "comments" | "docs" | "adr";

const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#(?!!)|<!--)/;

/** The kinds of change in a diff: ADR files, other doc files, comment-only edits, test code or other code. */
export function changeKinds(diff: string): Set<ChangeKind> {
  const kinds = new Set<ChangeKind>();
  for (const { file, text } of splitDiff(diff)) {
    if (DOC_FILE.test(file)) {
      kinds.add(/(^|\/)docs\/adr\//.test(file) ? "adr" : "docs");
      continue;
    }
    const changed = text
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .map((l) => l.slice(1))
      .filter((l) => l.trim());
    if (!changed.length) continue;
    if (changed.every((l) => COMMENT_LINE.test(l))) kinds.add("comments");
    else kinds.add(TEST_FILE.test(file) ? "tests" : "code");
  }
  return kinds;
}

/** Who reviews each kind of change in a later round. Code can break anything, so it gets everyone. */
const REVIEWERS_FOR: Record<ChangeKind, string[] | "all"> = {
  code: "all",
  tests: ["tests"],
  comments: ["docs"],
  docs: ["docs"],
  adr: ["architecture", "docs"],
};

/**
 * Which reviewers a later round needs, or undefined on a first round or when
 * the change since the last round is unknown. They are the reviewers whose
 * area the changes touch, plus each reviewer with a finding from the last
 * round, so it can check the fix.
 */
export function roundScope(ctx: ReviewContext): { kinds: ChangeKind[]; reviewers: Set<string> } | undefined {
  if (!ctx.prior.length || ctx.delta === undefined) return undefined;
  const kinds = changeKinds(ctx.delta);
  if (kinds.has("code")) return { kinds: [...kinds], reviewers: new Set(Object.keys(REVIEWERS)) };
  const last = Math.max(...ctx.prior.map((p) => p.round));
  const reviewers = new Set([
    ...[...kinds].flatMap((k) => REVIEWERS_FOR[k] as string[]),
    ...ctx.prior.filter((p) => p.round === last && p.status !== "escalated").map((p) => p.reviewer),
  ]);
  return { kinds: [...kinds], reviewers };
}
