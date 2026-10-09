/**
 * Architecture decision records in `<artifactsDir>/docs/adr/NNNN-*.md`.
 *
 * An accepted ADR's decision is never rewritten. A later ADR replaces it
 * ("Supersedes") or changes part of it ("Amends"), and both files record the
 * link under `## Relations`. Reading ADRs for a task follows those links: a
 * superseded ADR is swapped for its replacement, and an amended ADR brings
 * its amendments along.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectConfig } from "./config";

export type AdrStatus = "proposed" | "accepted" | "superseded" | "deprecated";

export const RELATION_KINDS = ["Supersedes", "Superseded by", "Amends", "Amended by", "Related to"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export type AdrRelation = { kind: RelationKind; id: string };

export type AdrRef = {
  id: string; // "ADR-0001"
  title: string;
  path: string;
  status: AdrStatus;
  relations: AdrRelation[];
  /** The "Decision" section, trimmed — enough for a reviewer, not the whole doc. */
  decision: string;
};

/** Each relation and the one the other ADR must record. */
export const INVERSE: Record<RelationKind, RelationKind> = {
  Supersedes: "Superseded by",
  "Superseded by": "Supersedes",
  Amends: "Amended by",
  "Amended by": "Amends",
  "Related to": "Related to",
};

const ADR_FILE = /^\d{4}-.*\.md$/;

/** Every ADR in the project, oldest first. Files that aren't numbered, such as a README, are skipped. */
export function allAdrs(config: ProjectConfig): AdrRef[] {
  const dir = join(config.artifactsDir, "docs", "adr");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ADR_FILE.test(f))
    .sort()
    .map((f) => parseAdr(join(dir, f)));
}

/**
 * The ADRs in force. With `only`, the ADRs a task names, after following
 * supersessions to the current replacement and adding any amendments.
 * Without it, every ADR that isn't superseded or deprecated.
 */
export function loadAdrs(config: ProjectConfig, only?: string[]): AdrRef[] {
  return resolveAdrs(allAdrs(config), only);
}

export function resolveAdrs(adrs: AdrRef[], only?: string[]): AdrRef[] {
  const byId = new Map(adrs.map((a) => [a.id, a]));
  const inForce = (a: AdrRef) => a.status !== "superseded" && a.status !== "deprecated";
  if (!only || only.length === 0) return adrs.filter(inForce);

  const picked = new Set<string>();
  const visit = (id: string, seen: Set<string>) => {
    const adr = byId.get(id);
    if (!adr || seen.has(id)) return;
    seen.add(id);
    const replacement = adr.relations.find((r) => r.kind === "Superseded by");
    if (adr.status === "superseded" && replacement) return visit(replacement.id, seen);
    if (!inForce(adr)) return;
    picked.add(id);
    for (const r of adr.relations) if (r.kind === "Amended by") visit(r.id, seen);
  };
  for (const id of only) visit(id, new Set());
  return adrs.filter((a) => picked.has(a.id));
}

/** One line per broken link: a missing ADR, a relation the other side doesn't record, or a status that disagrees. */
export function checkAdrs(adrs: AdrRef[]): string[] {
  const byId = new Map(adrs.map((a) => [a.id, a]));
  const problems: string[] = [];
  for (const a of adrs) {
    for (const r of a.relations) {
      const other = byId.get(r.id);
      if (!other) {
        problems.push(`${a.id}: "${r.kind} ${r.id}" points at an ADR that doesn't exist`);
        continue;
      }
      if (!other.relations.some((o) => o.kind === INVERSE[r.kind] && o.id === a.id)) {
        problems.push(`${a.id}: "${r.kind} ${r.id}", but ${r.id} doesn't record "${INVERSE[r.kind]} ${a.id}"`);
      }
    }
    const supersededBy = a.relations.some((r) => r.kind === "Superseded by");
    if (a.status === "superseded" && !supersededBy) problems.push(`${a.id}: status is superseded but no "Superseded by" relation names the replacement`);
    if (supersededBy && a.status !== "superseded") problems.push(`${a.id}: has "Superseded by" but its status is ${a.status}`);
  }
  return problems;
}

export function parseAdr(path: string): AdrRef {
  const text = readFileSync(path, "utf8");
  const heading = text.match(/^#\s+(ADR-\d+)[:\s-]*(.*)$/m);
  const num = basename(path).match(/^(\d{4})/)?.[1] ?? "0000";
  return {
    id: heading?.[1] ?? `ADR-${num}`,
    title: heading?.[2]?.trim() ?? path,
    path,
    status: parseStatus(section(text, "Status")),
    relations: parseRelations(section(text, "Relations")),
    decision: section(text, "Decision").slice(0, 800),
  };
}

function section(text: string, name: string): string {
  return text.match(new RegExp(`^##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, "m"))?.[1]?.trim() ?? "";
}

function parseStatus(status: string): AdrStatus {
  const word = status.split(/\s/)[0]?.toLowerCase();
  return word === "accepted" || word === "superseded" || word === "deprecated" ? word : "proposed";
}

/** Lines such as "- Amends [ADR-0001](0001-name.md): narrows the lint clause." */
export function parseRelations(block: string): AdrRelation[] {
  const kinds = [...RELATION_KINDS].sort((a, b) => b.length - a.length).join("|");
  const line = new RegExp(`^[-*]\\s*(${kinds})\\s+\\[?(ADR-\\d{4})`, "i");
  return block.split("\n").flatMap((l) => {
    const m = l.trim().match(line);
    if (!m) return [];
    const kind = RELATION_KINDS.find((k) => k.toLowerCase() === m[1]!.toLowerCase())!;
    return [{ kind, id: m[2]!.toUpperCase() }];
  });
}

/** "ADR-0006: Title (amends ADR-0001)", so a reader knows to take the two together. */
export function adrHeading(a: AdrRef): string {
  const ids = (kind: RelationKind) => a.relations.filter((r) => r.kind === kind).map((r) => r.id);
  const notes = [
    ids("Amends").length ? `amends ${ids("Amends").join(", ")}` : "",
    ids("Amended by").length ? `amended by ${ids("Amended by").join(", ")}` : "",
  ].filter(Boolean);
  return `${a.id}: ${a.title}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}
