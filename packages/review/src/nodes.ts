/**
 * Review nodes. Each is `(state) => Partial<state>`; dependencies come in
 * through `deps`. Node kinds, in order:
 *
 *   loadContext   deterministic  read diff, task, ADRs, conventions
 *   reviewer      generative     one specialist, run N times in parallel
 *   aggregate     deterministic  de-duplicate across specialists
 *   verify        generative     is each finding valid, or does it conflict with a rule or an earlier round?
 *   triage        judge          how severe is each valid finding?
 *   decide        deterministic  pass / fix / escalate from the triaged list
 *   report        deterministic  one-screen digest for you
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  changedFiles,
  filterDiff,
  loadStandards,
  reviewIgnore,
  loadAdrs,
  loadPrompt,
  logEntry,
  modelFor,
  noul,
  parseJsonReply,
  render,
  score,
  SEVERITIES,
  totalCost,
  type Finding,
  type FlowDeps,
  type Severity,
  type TriagedFinding,
  type Verification,
} from "@flows/core";
import { decisionsText, laterRound, priorText, REVIEWERS, standardsFor } from "./reviewers";
import type { MergedFinding, ReviewContext, ReviewState, ReviewUpdate, VerifiedFinding } from "./state";

// ── loadContext ─────────────────────────────────────────────────────────────

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

// ── reviewer (fan-out target) ───────────────────────────────────────────────

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

// ── aggregate ───────────────────────────────────────────────────────────────

export const aggregate = async (state: ReviewState): Promise<ReviewUpdate> => {
  const merged = dedupeFindings(state.rawFindings);
  return {
    merged,
    log: [logEntry("review.aggregate", { note: `${state.rawFindings.length} → ${merged.length} after dedupe` })],
  };
};

/**
 * Two findings are "the same" when they point at the same file, within a few
 * lines, and their titles overlap. The survivor keeps the higher severity and
 * remembers who else raised it — agreement is a useful signal for triage.
 */
export function dedupeFindings(findings: Finding[]): MergedFinding[] {
  const out: MergedFinding[] = [];
  for (const f of findings) {
    const twin = out.find(
      (m) =>
        m.file === f.file &&
        (m.line === undefined || f.line === undefined || Math.abs(m.line - f.line) <= 3) &&
        titleOverlap(m.title, f.title) >= 0.3,
    );
    if (!twin) {
      out.push({ ...f, alsoRaisedBy: [] });
      continue;
    }
    if (twin.reviewer !== f.reviewer && !twin.alsoRaisedBy.includes(f.reviewer)) twin.alsoRaisedBy.push(f.reviewer);
    if (rank(f.severity) > rank(twin.severity)) twin.severity = f.severity;
  }
  return out;
}

function titleOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size;
}

// ── verify (generative) ─────────────────────────────────────────────────────

/** How much of a file the verifier reads. Big enough for most source files. */
const FILE_LIMIT = 30_000;

/**
 * One call per finding, in parallel. The verifier sees what a reviewer
 * doesn't: the whole file, every ADR and standard, and earlier rounds. It
 * tries to refute the finding, and catches the ones that would undo an
 * earlier fix or break a rule another reviewer checks. Shared rules go first
 * in the prompt so the provider's prefix cache covers them across calls.
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
          return { ...f, verification: parseVerification(res.text) };
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

/** A finding the verifier couldn't check goes on to triage as before, rather than being dropped. */
const UNCHECKED = (why: string): Verification => ({ verdict: "valid", evidence: `Not verified: ${why}`, checked: false });

const VERDICTS = ["valid", "invalid", "conflict"] as const;

/** The verifier's reply. A "valid" that quotes nothing counts as invalid; an unreadable reply leaves the finding unchecked. */
export function parseVerification(text: string): Verification {
  const r = parseJsonReply<{ verdict?: string; evidence?: string; conflictsWith?: string; maxSeverity?: string }>(text, {});
  if (!VERDICTS.includes(r.verdict as any)) return UNCHECKED("the verifier gave no verdict");
  const evidence = String(r.evidence ?? "").trim();
  const maxSeverity = SEVERITIES.includes(r.maxSeverity as Severity) ? (r.maxSeverity as Severity) : undefined;
  if (r.verdict === "valid" && !evidence) return { verdict: "invalid", evidence: "The verifier found no line or rule that shows the problem.", checked: true };
  return {
    verdict: r.verdict as Verification["verdict"],
    evidence,
    conflictsWith: r.verdict === "conflict" ? String(r.conflictsWith ?? "").trim() || "an unnamed rule" : undefined,
    maxSeverity,
    checked: true,
  };
}

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

// ── triage (judge) ──────────────────────────────────────────────────────────

/** The same scale the reviewers use (prompts/review/_output.md), so the judge doesn't invent its own. */
export const SEVERITY_QUESTION =
  "How severe is the problem if merged as-is? blocker: a security hole in code that runs, data loss, or a broken build. " +
  "major: a bug in code that runs, a missed acceptance criterion, or a broken ADR or project standard. " +
  "minor: hardening beyond what the task asks, unusual ways around a rule, or unclear docs. nit: taste. " +
  "If neither the task nor an ADR nor a project standard asks for it, it is minor at most. " +
  "Docs and comments are minor at most. " +
  "Asking the change to build something a later task will build, rather than fixing something it contradicts, is minor at most.";

const REAL_QUESTION =
  "Is this finding a real, actionable problem introduced by this change — not a style preference, not speculation about code outside the diff?";

/**
 * The judge rates how severe each valid finding is. Invalid findings and
 * conflicts skip it: invalid ones drop, and conflicts go to a person. Only a
 * finding the verifier couldn't check still gets the judge's "is it real?"
 * question and the `minConfidence` cut.
 */
export const triage =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const verified = state.verified ?? (state.merged ?? []).map((f) => ({ ...f, verification: UNCHECKED("verify did not run") }));
    const { minConfidence, dropSeverities } = deps.config.review;

    // One judge call per finding, all in parallel. With Jev each is a few
    // hundred ms and a fraction of a cent.
    const findings: TriagedFinding[] = await Promise.all(
      verified.map(async (f): Promise<TriagedFinding> => {
        const v = f.verification;
        if (v.checked && v.verdict !== "valid") return { ...f, judgedSeverity: f.severity, confidence: 0, kept: false };

        const judgeState = {
          finding: f,
          code: fileDiff(state.input.diff, f.file),
          task: state.input.task ? { title: state.input.task.title, acceptanceCriteria: state.input.task.acceptanceCriteria } : undefined,
        };
        const severity = score(SEVERITY_QUESTION, SEVERITIES);
        const a = v.checked
          ? { ...(await deps.judge.ask(judgeState, { severity })), real: { p: 1 } }
          : await deps.judge.ask(judgeState, { real: noul(REAL_QUESTION), severity });
        // Independent reviewers agreeing is evidence; nudge confidence up a little.
        const confidence = Math.min(1, a.real.p + 0.1 * f.alsoRaisedBy.length);
        const judgedSeverity = capAt(capSeverity(f.reviewer, a.severity.level), v.maxSeverity);
        return {
          ...f,
          judgedSeverity,
          confidence,
          // A finding that would undo an earlier round goes to a person, not the agent.
          kept: !f.reverses && confidence >= minConfidence && !dropSeverities.includes(judgedSeverity),
        };
      }),
    );

    const kept = findings.filter((f) => f.kept).length;
    return {
      findings,
      log: [logEntry("review.triage", { note: `${deps.judge.name}: kept ${kept}/${findings.length}` })],
    };
  };

const capAt = (severity: Severity, cap?: Severity): Severity => (cap && rank(severity) > rank(cap) ? cap : severity);

/**
 * Policy, not judgement: some reviewers can never block a merge. Docs
 * findings stop at minor; wrong instructions that matter show up in the
 * correctness or spec review too.
 */
export const SEVERITY_CAP: Record<string, Severity> = { docs: "minor" };

export function capSeverity(reviewer: string, severity: Severity): Severity {
  return capAt(severity, SEVERITY_CAP[reviewer]);
}

/** Just the part of the diff for one file — the judge doesn't need the rest. */
export function fileDiff(diff: string, file?: string, limit = 4000): string {
  if (!file) return diff.slice(0, limit);
  const parts = diff.split(/^(?=diff --git )/m);
  return (parts.find((p) => p.includes(`b/${file}`)) ?? diff).slice(0, limit);
}

// ── decide (deterministic) ──────────────────────────────────────────────────

/**
 * Deliberately plain code. The judge already answered the fuzzy questions;
 * turning those answers into a verdict is policy, and policy belongs in code
 * you can read, test and change.
 */
export const decide =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const { verdict, reason } = decideVerdict(state.findings ?? [], deps.config.review);
    return { verdict, verdictReason: reason, log: [logEntry("review.decide", { note: `${verdict}: ${reason}` })] };
  };

export function decideVerdict(
  findings: TriagedFinding[],
  policy: { minConfidence: number; escalateAtSeverity: Severity },
): { verdict: "pass" | "fix" | "escalate"; reason: string } {
  // Two rules, or two rounds, pull opposite ways. Fixing either side would
  // only bring the other back next round, so a person decides once.
  const conflicts = findings.filter(isConflict);
  if (conflicts.length) {
    return { verdict: "escalate", reason: `reviewers disagree: ${conflicts.map((f) => `"${f.title}" vs ${conflictWith(f)}`).join("; ")}` };
  }

  // Serious but uncertain → a human should look. Findings the verifier ruled out aren't uncertain.
  const unsure = findings.filter(
    (f) =>
      !isRuledOut(f) && rank(f.judgedSeverity) >= rank(policy.escalateAtSeverity) && f.confidence < policy.minConfidence,
  );
  if (unsure.length) return { verdict: "escalate", reason: `${unsure.length} serious finding(s) the judge isn't sure about` };

  const mustFix = findings.filter((f) => f.kept && rank(f.judgedSeverity) >= rank("major"));
  if (mustFix.length) return { verdict: "fix", reason: `${mustFix.length} major/blocker finding(s)` };

  const minors = findings.filter((f) => f.kept).length;
  return { verdict: "pass", reason: minors ? `${minors} minor comment(s), nothing blocking` : "no findings" };
}

/** The verifier found a clash with a rule or earlier round, or the reviewer said it would undo one. */
export const isConflict = (f: TriagedFinding) =>
  (f.verification?.checked && f.verification.verdict === "conflict") || (!!f.reverses && !isRuledOut(f));

/** The verifier showed the finding is wrong. */
export const isInvalid = (f: TriagedFinding) => !!f.verification?.checked && f.verification.verdict === "invalid";

const isRuledOut = (f: TriagedFinding) => !!f.verification?.checked && f.verification.verdict !== "valid";

export const conflictWith = (f: TriagedFinding) =>
  f.verification?.verdict === "conflict" ? (f.verification.conflictsWith ?? "a rule") : `an earlier request ("${f.reverses}")`;

// ── report ──────────────────────────────────────────────────────────────────

export const report = async (state: ReviewState): Promise<ReviewUpdate> => {
  const findings = state.findings ?? [];
  const kept = findings.filter((f) => f.kept).sort((a, b) => rank(b.judgedSeverity) - rank(a.judgedSeverity));
  const dropped = findings.length - kept.length;
  const icon = { pass: "✅", fix: "🔧", escalate: "🙋" }[state.verdict ?? "pass"];

  const rows = kept.map(
    (f) =>
      `| ${f.judgedSeverity} | ${f.title} | ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "—"} | ${[f.reviewer, ...(f.alsoRaisedBy ?? [])].join(", ")} | ${f.confidence.toFixed(2)} |`,
  );

  const conflicts = findings.filter(isConflict);
  const invalid = findings.filter(isInvalid);
  const where = (f: TriagedFinding) => (f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "");

  const md = [
    `# Review — ${state.input.label}`,
    "",
    `**Verdict:** ${icon} ${state.verdict} — ${state.verdictReason}`,
    "",
    kept.length
      ? ["| Severity | Finding | Where | Raised by | Confidence |", "|---|---|---|---|---|", ...rows].join("\n")
      : "_No findings worth your time._",
    "",
    dropped - conflicts.length - invalid.length > 0
      ? `<sub>${dropped - conflicts.length - invalid.length} low-value finding(s) filtered by the judge.</sub>`
      : "",
    "",
    "## Details",
    ...kept.map((f) => `### ${f.title}\n${f.rationale}${f.suggestion ? `\n\n**Suggestion:** ${f.suggestion}` : ""}`),
    "",
    ...(conflicts.length
      ? [
          "## Conflicts for you to decide",
          "These would undo a rule or an earlier round's change, so they didn't go to the agent.",
          "",
          ...conflicts.map((f) => `- **${f.title}**${where(f)} from ${f.reviewer}, against ${conflictWith(f)}. ${f.verification?.evidence ?? ""}`.trim()),
          "",
        ]
      : []),
    ...(invalid.length
      ? [
          "## Dropped by verification",
          ...invalid.map((f) => `- **${f.title}**${where(f)} from ${f.reviewer}: ${f.verification!.evidence}`),
          "",
        ]
      : []),
    "## Provenance",
    ...state.log.map((e) => `- \`${e.node}\`${e.model ? ` (${e.model})` : ""}${e.note ? ` — ${e.note}` : ""}`),
    `- total model cost: $${totalCost(state.log).toFixed(4)}`,
  ].join("\n");

  return { report: md };
};

// ── helpers ─────────────────────────────────────────────────────────────────

export const rank = (s: Severity) => SEVERITIES.indexOf(s);

function asSeverity(x: unknown): Severity {
  return SEVERITIES.includes(x as Severity) ? (x as Severity) : "minor";
}
