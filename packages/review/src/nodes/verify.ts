import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPrompt, logEntry, modelFor, parseJsonReply, render, SEVERITIES, type FlowDeps, type Severity, type Verification } from "@flows/core";
import { decisionsText, priorText } from "../reviewers";
import type { MergedFinding, ReviewState, ReviewUpdate, VerifiedFinding } from "../state";
import { fileDiff, UNCHECKED } from "./shared";

/** How much of a file the verifier reads. Big enough for most source files. */
const FILE_LIMIT = 30_000;

/**
 * Generative. One call per finding, in parallel. The verifier sees what a
 * reviewer doesn't: the whole file, every ADR and standard, and earlier
 * rounds. It tries to refute the finding, and catches the ones that would
 * undo an earlier fix or break a rule another reviewer checks. Shared rules
 * go first in the prompt so the provider's prefix cache covers them across
 * calls.
 *
 * Reads `merged`, `context` and `input.workdir`. Writes `verified`. A
 * finding the verifier couldn't check stays valid and unchecked. When the
 * verifier gives a fix that keeps to the rules, it replaces the reviewer's
 * suggestion.
 */
export const verify =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const merged = state.merged ?? [];
    const ctx = state.context;
    if (!merged.length || !ctx) return { verified: merged.map((f) => ({ ...f, verification: UNCHECKED("no context") })) };

    const shared = {
      decisions: decisionsText(ctx.allAdrs),
      standards: ctx.standards.length ? ctx.standards.map((s) => `### ${s.path}\n${s.text.trim()}`).join("\n\n") : "(none)",
      conventions: ctx.conventions.length ? ctx.conventions.map((c) => `- ${c}`).join("\n") : "(none)",
      acceptance_criteria: ctx.task?.acceptanceCriteria.length ? ctx.task.acceptanceCriteria.map((c) => `- ${c}`).join("\n") : "(none)",
      prior: priorText(ctx.prior),
    };
    const template = loadPrompt("review/verify");
    const model = modelFor(deps.config, "verifier");

    let cost = 0;
    const verified: VerifiedFinding[] = await Promise.all(
      merged.map(async (f) => {
        const user = render(template, {
          ...shared,
          reviewer: f.reviewer,
          severity: f.severity,
          finding: findingText(f),
          file_diff: fileDiff(ctx.diff, f.file, 8000),
          file_text: fileText(state.input.workdir, f.file),
        });
        try {
          const res = await deps.model.complete({
            tag: "review.verify",
            model,
            json: true,
            system: "You check code review findings before anyone acts on them. You are skeptical and cite evidence.",
            user,
          });
          cost += res.costUsd ?? 0;
          const verification = parseVerification(res.text);
          return { ...f, suggestion: verification.fix ?? f.suggestion, verification };
        } catch (e: any) {
          return { ...f, verification: UNCHECKED(String(e?.message ?? e).split("\n")[0]!) };
        }
      }),
    );

    const count = (v: Verification["verdict"]) => verified.filter((f) => f.verification.checked && f.verification.verdict === v).length;
    const unchecked = verified.filter((f) => !f.verification.checked).length;
    return {
      verified,
      log: [
        logEntry("review.verify", {
          model,
          costUsd: cost,
          note: `${count("valid")} valid, ${count("invalid")} invalid, ${count("conflict")} conflict${unchecked ? `, ${unchecked} unchecked` : ""}`,
        }),
      ],
    };
  };

const VERDICTS = ["valid", "invalid", "conflict"] as const;

/**
 * The verifier's reply. A "valid" that quotes nothing counts as invalid; an
 * unreadable reply leaves the finding unchecked. Only a valid finding keeps
 * a `fix`.
 */
export function parseVerification(text: string): Verification {
  const r = parseJsonReply<{ verdict?: string; evidence?: string; fix?: string; conflictsWith?: string; maxSeverity?: string }>(text, {});
  if (!VERDICTS.includes(r.verdict as any)) return UNCHECKED("the verifier gave no verdict");
  const evidence = String(r.evidence ?? "").trim();
  const maxSeverity = SEVERITIES.includes(r.maxSeverity as Severity) ? (r.maxSeverity as Severity) : undefined;
  if (r.verdict === "valid" && !evidence) return { verdict: "invalid", evidence: "The verifier found no line or rule that shows the problem.", checked: true };
  return {
    verdict: r.verdict as Verification["verdict"],
    evidence,
    conflictsWith: r.verdict === "conflict" ? String(r.conflictsWith ?? "").trim() || "an unnamed rule" : undefined,
    fix: r.verdict === "valid" ? String(r.fix ?? "").trim() || undefined : undefined,
    maxSeverity,
    checked: true,
  };
}

/** The finding as the verifier reads it: title and place, rationale, suggestion and what it would undo. */
function findingText(f: MergedFinding): string {
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no file)";
  return [`${f.title} (${where})`, f.rationale, f.suggestion ? `Suggestion: ${f.suggestion}` : "", f.reverses ? `Would undo: ${f.reverses}` : ""]
    .filter(Boolean)
    .join("\n");
}

/** The cited file from the checkout, when there is one. */
export function fileText(workdir: string | undefined, file: string | undefined): string {
  if (!workdir || !file) return "(not available; use the diff above)";
  const path = join(workdir, file);
  if (!path.startsWith(join(workdir, "/")) || !existsSync(path)) return "(not in the checkout; use the diff above)";
  const text = readFileSync(path, "utf8");
  return text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}\n… (cut at ${FILE_LIMIT} characters)` : text;
}
