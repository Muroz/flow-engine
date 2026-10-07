/**
 * What each planning gate shows. A gate summary fits one screen; the full
 * text goes to a detail file the gate links to.
 */
import type { PlannedTask } from "@flows/core";
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

export function planSummary(chosen: ArchOption | undefined, adrs: DraftAdr[], tasks: PlannedTask[], gaps: string[]): string {
  const starters = tasks.filter((t) => t.dependsOn.length === 0);
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
  ].join("\n");
}

export function planDetail(tasks: PlannedTask[]): string {
  return [
    "# Tasks",
    "",
    "| Task | Title | Risk | Size | Needs first | Requirements |",
    "|---|---|---|---|---|---|",
    ...tasks.map((t) => `| ${t.id} | ${t.title} | ${t.risk} | ${t.estimate ?? ""} | ${t.dependsOn.join(", ")} | ${t.requirementIds.join(", ")} |`),
  ].join("\n");
}
