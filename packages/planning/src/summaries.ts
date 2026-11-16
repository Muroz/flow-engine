/**
 * What each planning gate shows. A gate summary fits one screen; the full
 * text goes to a detail file the gate links to.
 */
import { clauseRefs, type PlannedTask } from "@flows/core";
import type { ArchOption, DraftAdr, Requirement } from "./state";

export const mvp = (rs: Requirement[]) => rs.filter((r) => r.priority === "mvp");

function byArea(rs: Requirement[]): Map<string, Requirement[]> {
  const areas = new Map<string, Requirement[]>();
  for (const r of rs) areas.set(r.area, [...(areas.get(r.area) ?? []), r]);
  return areas;
}

// ── scope ───────────────────────────────────────────────────────────────────

export type RequirementDiff = { added: string[]; removed: string[]; changed: string[]; toLater: string[]; toMvp: string[] };

export function diffRequirements(before: Requirement[], after: Requirement[]): RequirementDiff {
  const old = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const d: RequirementDiff = { added: [], removed: [], changed: [], toLater: [], toMvp: [] };
  for (const r of after) {
    const o = old.get(r.id);
    if (!o) d.added.push(r.id);
    else if (o.priority !== r.priority) (r.priority === "later" ? d.toLater : d.toMvp).push(r.id);
    else if (o.text !== r.text || o.title !== r.title || o.area !== r.area) d.changed.push(r.id);
  }
  for (const r of before) if (!now.has(r.id)) d.removed.push(r.id);
  return d;
}

export function describeDiff(d: RequirementDiff): string {
  const parts = [
    d.added.length && `Added ${d.added.join(", ")}`,
    d.removed.length && `Removed ${d.removed.join(", ")}`,
    d.changed.length && `Changed ${d.changed.join(", ")}`,
    d.toLater.length && `Moved to later ${d.toLater.join(", ")}`,
    d.toMvp.length && `Moved to MVP ${d.toMvp.join(", ")}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No changes";
}

export function scopeSummary(rs: Requirement[], previous: Requirement[]): string {
  const lines: string[] = [];
  if (previous.length) lines.push(`Since your last notes: ${describeDiff(diffRequirements(previous, rs))}`, "");
  for (const [area, items] of byArea(rs)) {
    const now = mvp(items);
    const later = items.length - now.length;
    lines.push(`${area} (${now.length} MVP${later ? `, ${later} later` : ""})`);
    for (const r of now) lines.push(`  ${r.id} ${r.title}`);
  }
  lines.push("", "To revise, write notes such as: R-12 later; drop R-30; Scheduling: add copy week forward");
  return lines.join("\n");
}

export function scopeDetail(rs: Requirement[]): string {
  const out = ["# Scope", ""];
  for (const [area, items] of byArea(rs)) {
    out.push(`## ${area}`, "");
    for (const r of items) out.push(`- **${r.id} ${r.title}**${r.priority === "later" ? " (later)" : ""}: ${r.text}`);
    out.push("");
  }
  return out.join("\n");
}

// ── architecture ────────────────────────────────────────────────────────────

export function archSummary(options: ArchOption[], recommendation: string | undefined): string {
  const lines = options.flatMap((o) => [
    `${o.id}  ${o.pitch}`,
    `   first delivery ${o.facts.firstDelivery} · cost ${o.facts.monthlyCost} · ops ${o.facts.opsBurden} · lock-in ${o.facts.lockIn}`,
  ]);
  return [
    ...lines,
    "",
    `Recommended: ${recommendation ?? "none"}`,
    "",
    "Pick a letter, or revise (new options from your notes) or adjust (notes such as: C: use Postgres row-level security).",
  ].join("\n");
}

export function archDetail(options: ArchOption[], recommendation: string | undefined): string {
  const out = ["# Architecture options", "", `Recommended: ${recommendation ?? "none"}`, ""];
  for (const o of options) {
    out.push(`## Option ${o.id}: ${o.angle}`, "", o.pitch, "", o.summary, "");
    out.push("| First delivery | Monthly cost | Ops burden | Lock-in |", "|---|---|---|---|");
    out.push(`| ${o.facts.firstDelivery} | ${o.facts.monthlyCost} | ${o.facts.opsBurden} | ${o.facts.lockIn} |`, "");
    out.push("Trade-offs:", ...o.tradeoffs.map((t) => `- ${t}`), "");
  }
  return out.join("\n");
}

/** `C: use row-level security` targets C; notes without a known letter target the fallback. */
export function parseAdjust(notes: string, ids: string[], fallback: string): { target: string; notes: string } {
  const m = notes.match(/^\s*([A-Za-z])\s*[:\-–]\s*([\s\S]*)$/);
  const id = m?.[1]?.toUpperCase();
  return id && ids.includes(id) ? { target: id, notes: m![2]!.trim() } : { target: fallback, notes: notes.trim() };
}

// ── plan ────────────────────────────────────────────────────────────────────

const countBy = <T>(xs: T[], key: (x: T) => string) =>
  Object.entries(xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {}))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");

/** Words a reviewer has to interpret. Each hides the behaviour the criterion should name. */
const VAGUE = /\b(robust(?:ly)?|secure(?:ly)?|properly|correctly|appropriate(?:ly)?|gracefully|seamless(?:ly)?|user-friendly|as needed|etc)\b/i;
/** A scope with no edge, unless the criterion also says what it leaves out. */
const BROAD = /\b(repo-wide|project-wide|codebase-wide|everywhere|across the (?:repo|codebase|project))\b/i;
const EXCLUDES = /\b(except|excluding|excludes|skip|skips|other than|outside of|but not|only)\b/i;

/**
 * Problems a reviewer would otherwise fill in with its own idea, one line
 * each: a task with no description or criteria, a vague or unbounded
 * criterion, a risky task with nothing out of scope, and citations of ADRs or
 * clauses the plan doesn't have.
 */
export function taskWarnings(tasks: PlannedTask[], adrs: DraftAdr[]): string[] {
  const byId = new Map(adrs.map((a) => [a.id, a]));
  return tasks.flatMap((t) => {
    const out: string[] = [];
    if (!t.description?.trim()) out.push(`${t.id}: no description`);
    if (!t.acceptanceCriteria.length) out.push(`${t.id}: no acceptance criteria`);
    for (const c of t.acceptanceCriteria) {
      const vague = c.match(VAGUE)?.[1];
      if (vague) out.push(`${t.id}: "${c}" uses "${vague}"; say what the code does instead`);
      if (BROAD.test(c) && !EXCLUDES.test(c)) out.push(`${t.id}: "${c}" is broad; say what it excludes`);
    }
    if (t.risk !== "low" && !t.outOfScope?.length) out.push(`${t.id}: ${t.risk} risk with nothing out of scope`);
    for (const id of t.adrRefs) if (!byId.has(id.match(/ADR-\d{4}/)?.[0] ?? id)) out.push(`${t.id}: cites ${id}, which the plan doesn't have`);
    for (const ref of clauseRefs([...t.acceptanceCriteria, t.description ?? ""].join("\n"))) {
      const adr = byId.get(ref.id);
      if (adr && ref.clause > adr.clauses.length) out.push(`${t.id}: cites ${ref.id} clause ${ref.clause}, which doesn't exist`);
    }
    return out;
  });
}

export function planSummary(chosen: ArchOption | undefined, adrs: DraftAdr[], tasks: PlannedTask[], gaps: string[]): string {
  const starters = tasks.filter((t) => t.dependsOn.length === 0);
  const warnings = taskWarnings(tasks, adrs);
  return [
    `Architecture: ${chosen ? `${chosen.id}, ${chosen.pitch}` : "none"}`,
    "",
    `Decisions (${adrs.length}):`,
    ...adrs.map((a) => `  ${a.id} ${a.title}`),
    "",
    `Tasks: ${tasks.length} · risk ${countBy(tasks, (t) => t.risk)} · size ${countBy(tasks, (t) => t.estimate ?? "?")}`,
    `Can start first (${starters.length}):`,
    ...starters.map((t) => `  ${t.id} ${t.title}`),
    ...(gaps.length ? ["", `Still not covered by any task: ${gaps.join(", ")}`] : []),
    ...(warnings.length
      ? ["", `Tasks a reviewer would have to interpret (${warnings.length}; all in plan.md):`, ...warnings.slice(0, 6).map((w) => `  ${w}`)]
      : []),
  ].join("\n");
}

export function planDetail(tasks: PlannedTask[], adrs: DraftAdr[] = []): string {
  const warnings = taskWarnings(tasks, adrs);
  const list = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => `- ${x}`) : ["- (none)"]);
  return [
    "# Tasks",
    "",
    "| Task | Title | Risk | Size | Needs first | Requirements |",
    "|---|---|---|---|---|---|",
    ...tasks.map((t) => `| ${t.id} | ${t.title} | ${t.risk} | ${t.estimate ?? ""} | ${t.dependsOn.join(", ")} | ${t.requirementIds.join(", ")} |`),
    ...(warnings.length ? ["", "## Warnings", "", ...warnings.map((w) => `- ${w}`)] : []),
    ...tasks.flatMap((t) => [
      "",
      `## ${t.id}: ${t.title}`,
      "",
      t.description ?? "(no description)",
      "",
      `ADRs: ${t.adrRefs.join(", ") || "none"}`,
      "",
      "Acceptance criteria:",
      ...list(t.acceptanceCriteria),
      "",
      "Out of scope:",
      ...list(t.outOfScope),
    ]),
  ].join("\n");
}
