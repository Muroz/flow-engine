/**
 * The triage table: the kinds of problem a review finding can describe, and
 * the severity each kind gets. The judge names the kind; this table, not the
 * judge, sets the severity. A project can change a built-in kind's severity
 * or add kinds of its own under `review.categories` in `.flows.yaml`.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "./artifacts";
import { SEVERITIES, type Severity } from "./types";

export type CategoryDef = { description: string; severity: Severity };
export type CategoryTable = Record<string, CategoryDef>;

/** Built from the reviewers' severity scale in prompts/review/_output.md. */
export const DEFAULT_CATEGORIES: CategoryTable = {
  // First, because the LLM judge falls back to the first option on an unreadable answer.
  bug: { description: "a bug in code that runs: a wrong result, a crash or an unhandled case for some input", severity: "major" },
  security: { description: "a security hole in code that runs, such as injection, a leaked secret or missing access control", severity: "blocker" },
  dataLoss: { description: "data loss or corruption", severity: "blocker" },
  brokenBuild: { description: "a broken build or a failing check", severity: "blocker" },
  missedCriterion: { description: "the change misses one of the task's acceptance criteria", severity: "major" },
  brokenRule: { description: "the change breaks an ADR or a project standard", severity: "major" },
  missingTests: { description: "behaviour the change adds or alters has no tests", severity: "major" },
  beyondTask: {
    description: "hardening or work beyond what the task, the ADRs and the standards ask for, such as something a later task builds, or an unusual way around a rule",
    severity: "minor",
  },
  docs: { description: "documentation or code comments", severity: "minor" },
  taste: { description: "style or taste, with no effect on behaviour", severity: "nit" },
};

/** The judge's answer when no kind fits. Reserved: a project can't redefine it. */
export const OTHER_CATEGORY = "other";
export const OTHER_DESCRIPTION = "none of the other kinds fits this finding";

/**
 * Above this many kinds, loading the config warns. Each kind is one more
 * option for the judge to tell apart, so a long table makes its choice less
 * reliable.
 */
export const CATEGORY_WARN_AT = 15;

const KEY = /^[a-zA-Z][a-zA-Z0-9]*$/;
const isSeverity = (x: unknown): x is Severity => SEVERITIES.includes(x as Severity);

/**
 * The project's table: the built-in kinds with `review.categories` from
 * `.flows.yaml` merged over them. A plain severity changes a built-in kind;
 * `{ description, severity }` adds a kind or replaces a built-in one. Throws
 * one error that lists every bad entry.
 */
export function parseCategories(raw: unknown): CategoryTable {
  if (raw === undefined || raw === null) return { ...DEFAULT_CATEGORIES };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("review.categories must be a map of kind to severity or { description, severity }.");
  const table: CategoryTable = { ...DEFAULT_CATEGORIES };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `review.categories.${key}`;
    if (key === OTHER_CATEGORY) {
      errors.push(`${at}: "${OTHER_CATEGORY}" is reserved for findings no kind fits.`);
    } else if (!KEY.test(key)) {
      errors.push(`${at}: a kind's name is letters and digits only, starting with a letter, such as "pii" or "slowQuery".`);
    } else if (typeof value === "string") {
      if (!isSeverity(value)) errors.push(`${at}: "${value}" isn't a severity. Use one of ${SEVERITIES.join(", ")}.`);
      else if (!table[key]) errors.push(`${at}: "${key}" isn't a built-in kind, so it needs { description, severity }.`);
      else table[key] = { ...table[key], severity: value };
    } else if (value && typeof value === "object") {
      const { description, severity } = value as { description?: unknown; severity?: unknown };
      if (typeof description !== "string" || !description.trim()) errors.push(`${at}: needs a description, which is what the judge reads.`);
      else if (!isSeverity(severity)) errors.push(`${at}: needs a severity, one of ${SEVERITIES.join(", ")}.`);
      else table[key] = { description: description.trim(), severity };
    } else {
      errors.push(`${at}: give a severity, or { description, severity }.`);
    }
  }
  if (errors.length) throw new Error(`Bad review.categories in .flows.yaml:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  return table;
}

/** Warnings about the triage table, such as one too long for the judge to choose from reliably. */
export function categoryWarnings(table: CategoryTable): string[] {
  const count = Object.keys(table).length;
  return count > CATEGORY_WARN_AT
    ? [
        `The triage table has ${count} kinds, more than ${CATEGORY_WARN_AT}. Each kind is one more option for the judge to tell apart, ` +
          "so its choices get less reliable. Merge kinds that share a severity, or drop ones your review reports rarely show.",
      ]
    : [];
}

/** A finding the table didn't fit well. */
export type TriageGap = {
  title: string;
  reviewer: string;
  rationale: string;
  /** The kind the judge picked: `other`, or one whose severity it was unsure of. */
  category: string;
  /** How sure the judge was of the severity, from 0 to 1. */
  confidence: number;
  /** Other kinds the judge gave real weight to, such as "security 0.35". */
  alternatives?: string[];
  severity: Severity;
};

/**
 * Appends findings the table didn't fit to `runs/<project>/triage-gaps.md`,
 * one line each, so you can see which kinds are missing. Returns the path.
 */
export function appendTriageGaps(project: string, label: string, gaps: TriageGap[]): string {
  const dir = join(ENGINE_ROOT, "runs", project);
  const path = join(dir, "triage-gaps.md");
  mkdirSync(dir, { recursive: true });
  const header = existsSync(path)
    ? ""
    : `# ${project} triage gaps\n\nFindings the triage table didn't fit: the judge answered "${OTHER_CATEGORY}", or was unsure which severity the finding's kind has. ` +
      "A pattern here is a kind worth adding under review.categories in .flows.yaml.\n";
  const date = new Date().toISOString().slice(0, 10);
  const lines = gaps.map(
    (g) =>
      `- ${date} · ${label} · "${g.title}" from ${g.reviewer}: judge said ${g.category} (confidence ${g.confidence.toFixed(2)}` +
      `${g.alternatives?.length ? `; also ${g.alternatives.join(", ")}` : ""}), ` +
      `kept as ${g.severity}. ${g.rationale.split(/(?<=\.)\s/)[0] ?? ""}`.trim(),
  );
  appendFileSync(path, `${header}\n${lines.join("\n")}\n`);
  return path;
}
