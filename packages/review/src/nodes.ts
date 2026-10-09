/**
 * Review nodes. Each is `(state) => Partial<state>`; dependencies come in
 * through `deps`. Node kinds, in order:
 *
 *   loadContext   deterministic  read diff, task, ADRs, conventions
 *   reviewer      generative     one specialist, run N times in parallel
 *   aggregate     deterministic  de-duplicate across specialists
 *   triage        judge          is each finding real? how severe?
 *   decide        deterministic  pass / fix / escalate from the triaged list
 *   report        deterministic  one-screen digest for you
 */
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
} from "@flows/core";
import { REVIEWERS, standardsFor } from "./reviewers";
import type { MergedFinding, ReviewState, ReviewUpdate } from "./state";

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
    const { task } = state.input;
    const adrs = loadAdrs(deps.config, task?.adrRefs);
    const files = changedFiles(diff);
    const standards = loadStandards(deps.config);
    return {
      context: { diff, files, skipped, task, adrs, conventions: deps.config.conventions, standards },
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
      output_format: loadPrompt("review/_output"),
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

// ── triage (judge) ──────────────────────────────────────────────────────────

/** The same scale the reviewers use (prompts/review/_output.md), so the judge doesn't invent its own. */
export const SEVERITY_QUESTION =
  "How severe is the problem if merged as-is? blocker: a security hole in code that runs, data loss, or a broken build. " +
  "major: a bug in code that runs, a missed acceptance criterion, or a broken ADR or project standard. " +
  "minor: hardening beyond what the task asks, unusual ways around a rule, or unclear docs. nit: taste. " +
  "If neither the task nor an ADR nor a project standard asks for it, it is minor at most. " +
  "Docs and comments are minor at most. " +
  "Asking the change to build something a later task will build, rather than fixing something it contradicts, is minor at most.";

export const triage =
  (deps: FlowDeps) =>
  async (state: ReviewState): Promise<ReviewUpdate> => {
    const merged = state.merged ?? [];
    const { minConfidence, dropSeverities } = deps.config.review;

    // One judge call per finding, all in parallel. With Jev each is a few
    // hundred ms and a fraction of a cent, so filtering every finding is cheap.
    const findings: TriagedFinding[] = await Promise.all(
      merged.map(async (f) => {
        const a = await deps.judge.ask(
          {
            finding: f,
            code: fileDiff(state.input.diff, f.file),
            task: state.input.task ? { title: state.input.task.title, acceptanceCriteria: state.input.task.acceptanceCriteria } : undefined,
          },
          {
            real: noul(
              "Is this finding a real, actionable problem introduced by this change — not a style preference, not speculation about code outside the diff?",
            ),
            severity: score(SEVERITY_QUESTION, SEVERITIES),
          },
        );
        // Independent reviewers agreeing is evidence; nudge confidence up a little.
        const confidence = Math.min(1, a.real.p + 0.1 * f.alsoRaisedBy.length);
        const judgedSeverity = capSeverity(f.reviewer, a.severity.level);
        return {
          ...f,
          judgedSeverity,
          confidence,
          kept: confidence >= minConfidence && !dropSeverities.includes(judgedSeverity),
        };
      }),
    );

    const kept = findings.filter((f) => f.kept).length;
    return {
      findings,
      log: [logEntry("review.triage", { note: `${deps.judge.name}: kept ${kept}/${findings.length}` })],
    };
  };

/**
 * Policy, not judgement: some reviewers can never block a merge. Docs
 * findings stop at minor; wrong instructions that matter show up in the
 * correctness or spec review too.
 */
export const SEVERITY_CAP: Record<string, Severity> = { docs: "minor" };

export function capSeverity(reviewer: string, severity: Severity): Severity {
  const cap = SEVERITY_CAP[reviewer];
  return cap && rank(severity) > rank(cap) ? cap : severity;
}

/** Just the part of the diff for one file — the judge doesn't need the rest. */
export function fileDiff(diff: string, file?: string): string {
  if (!file) return diff.slice(0, 4000);
  const parts = diff.split(/^(?=diff --git )/m);
  return (parts.find((p) => p.includes(`b/${file}`)) ?? diff).slice(0, 4000);
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
  // Serious but uncertain → a human should look. Checked first on purpose.
  const unsure = findings.filter(
    (f) => rank(f.judgedSeverity) >= rank(policy.escalateAtSeverity) && f.confidence < policy.minConfidence,
  );
  if (unsure.length) return { verdict: "escalate", reason: `${unsure.length} serious finding(s) the judge isn't sure about` };

  const mustFix = findings.filter((f) => f.kept && rank(f.judgedSeverity) >= rank("major"));
  if (mustFix.length) return { verdict: "fix", reason: `${mustFix.length} major/blocker finding(s)` };

  const minors = findings.filter((f) => f.kept).length;
  return { verdict: "pass", reason: minors ? `${minors} minor comment(s), nothing blocking` : "no findings" };
}

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

  const md = [
    `# Review — ${state.input.label}`,
    "",
    `**Verdict:** ${icon} ${state.verdict} — ${state.verdictReason}`,
    "",
    kept.length
      ? ["| Severity | Finding | Where | Raised by | Confidence |", "|---|---|---|---|---|", ...rows].join("\n")
      : "_No findings worth your time._",
    "",
    dropped ? `<sub>${dropped} low-value finding(s) filtered by the judge.</sub>` : "",
    "",
    "## Details",
    ...kept.map((f) => `### ${f.title}\n${f.rationale}${f.suggestion ? `\n\n**Suggestion:** ${f.suggestion}` : ""}`),
    "",
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
