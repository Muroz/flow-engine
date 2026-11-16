/**
 * Architecture decision records in `<artifactsDir>/docs/adr/NNNN-*.md`.
 *
 * Every ADR follows Nygard's structure, filled from `templates/adr.md`: a
 * title, a `Date:` line, then Status, Relations, Context, Decision and
 * Consequences. The Decision is a numbered list of clauses, each one rule a
 * reviewer can check, so other ADRs, tasks and findings can cite "ADR-0001
 * clause 3".
 *
 * An accepted ADR's decision is never rewritten. A later ADR replaces it
 * ("Supersedes") or changes some of its clauses ("Amends ... clause 3"), and
 * both files record the link, with the same clause numbers, under
 * `## Relations`. Reading ADRs for a task follows those links: a superseded
 * ADR is swapped for its replacement, and an amended ADR brings its
 * amendments along.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ENGINE_ROOT } from "./artifacts";
import type { ProjectConfig } from "./config";
import { render } from "./prompts";

export type AdrStatus = "proposed" | "accepted" | "superseded" | "deprecated";

export const RELATION_KINDS = ["Supersedes", "Superseded by", "Amends", "Amended by", "Related to"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
/** `clauses` are always the amended ADR's clause numbers, on both sides of an Amends link. */
export type AdrRelation = { kind: RelationKind; id: string; clauses?: number[] };

/** One numbered rule in an ADR's Decision. */
export type AdrClause = { n: number; text: string };

export type AdrRef = {
  id: string; // "ADR-0001"
  title: string;
  path: string;
  date?: string;
  status: AdrStatus;
  relations: AdrRelation[];
  clauses: AdrClause[];
  /** Where the file departs from the template. `checkAdrs` reports them. */
  formatProblems?: string[];
};

/** Each relation and the one the other ADR must record. */
export const INVERSE: Record<RelationKind, RelationKind> = {
  Supersedes: "Superseded by",
  "Superseded by": "Supersedes",
  Amends: "Amended by",
  "Amended by": "Amends",
  "Related to": "Related to",
};

export const SECTIONS = ["Status", "Relations", "Context", "Decision", "Consequences"] as const;

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
  // Tasks may cite a clause, such as "ADR-0001 clause 3"; the whole ADR comes along.
  for (const id of only) visit(id.match(/ADR-\d{4}/)?.[0] ?? id, new Set());
  return adrs.filter((a) => picked.has(a.id));
}

/**
 * One line per problem: a file that departs from the template, a link to a
 * missing ADR, a relation the other side doesn't record or records with other
 * clauses, an amendment that names no clause or a clause that doesn't exist,
 * a clause reference to nothing, or a status that disagrees with the links.
 */
export function checkAdrs(adrs: AdrRef[]): string[] {
  const byId = new Map(adrs.map((a) => [a.id, a]));
  const problems: string[] = [];
  const sameClauses = (x?: number[], y?: number[]) => (x ?? []).join(",") === (y ?? []).join(",");
  for (const a of adrs) {
    problems.push(...(a.formatProblems ?? []).map((p) => `${a.id}: ${p}`));
    for (const r of a.relations) {
      const other = byId.get(r.id);
      if (!other) {
        problems.push(`${a.id}: "${r.kind} ${r.id}" points at an ADR that doesn't exist`);
        continue;
      }
      if (!other.relations.some((o) => o.kind === INVERSE[r.kind] && o.id === a.id && sameClauses(o.clauses, r.clauses))) {
        problems.push(`${a.id}: "${describeRelation(r)}", but ${r.id} doesn't record "${describeRelation({ ...r, kind: INVERSE[r.kind], id: a.id })}"`);
      }
      if (r.kind === "Amends" || r.kind === "Amended by") {
        const amended = r.kind === "Amends" ? other : a;
        if (!r.clauses?.length) problems.push(`${a.id}: "${r.kind} ${r.id}" names no clause; write "${r.kind} ${r.id} clause N"`);
        for (const n of r.clauses ?? []) {
          if (!amended.clauses.some((c) => c.n === n)) problems.push(`${a.id}: "${describeRelation(r)}", but ${amended.id} has no clause ${n}`);
        }
      }
    }
    for (const c of a.clauses) {
      for (const ref of clauseRefs(c.text)) {
        const target = byId.get(ref.id);
        if (target && !target.clauses.some((t) => t.n === ref.clause)) {
          problems.push(`${a.id} clause ${c.n} cites ${ref.id} clause ${ref.clause}, which doesn't exist`);
        }
      }
    }
    const supersededBy = a.relations.some((r) => r.kind === "Superseded by");
    if (a.status === "superseded" && !supersededBy) problems.push(`${a.id}: status is superseded but no "Superseded by" relation names the replacement`);
    if (supersededBy && a.status !== "superseded") problems.push(`${a.id}: has "Superseded by" but its status is ${a.status}`);
  }
  return problems;
}

/** "Amends ADR-0001 clauses 2, 3", the way a Relations line names a link. */
export function describeRelation(r: AdrRelation): string {
  const clauses = r.clauses?.length ? ` clause${r.clauses.length > 1 ? "s" : ""} ${r.clauses.join(", ")}` : "";
  return `${r.kind} ${r.id}${clauses}`;
}

/** Every "ADR-0001 clause 3" or "ADR-0001 clauses 2 and 3" in a piece of text. */
export function clauseRefs(text: string): { id: string; clause: number }[] {
  return [...text.matchAll(/(ADR-\d{4})\s+clauses?\s+(\d+(?:\s*(?:,|and|&)\s*\d+)*)/gi)].flatMap((m) =>
    numbers(m[2]!).map((clause) => ({ id: m[1]!.toUpperCase(), clause })),
  );
}

const numbers = (s: string) => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));

export function parseAdr(path: string): AdrRef {
  return parseAdrText(readFileSync(path, "utf8"), path);
}

export function parseAdrText(text: string, path: string): AdrRef {
  const heading = text.match(/^#\s+(ADR-\d+)[:\s-]*(.*)$/m);
  const num = basename(path).match(/^(\d{4})/)?.[1] ?? "0000";
  const date = text.match(/^Date:\s*(\S.*)$/m)?.[1]?.trim();
  const decision = section(text, "Decision");
  const clauses = parseClauses(decision);
  const adr: AdrRef = {
    id: heading?.[1] ?? `ADR-${num}`,
    title: heading?.[2]?.trim() ?? path,
    path,
    date,
    status: parseStatus(section(text, "Status")),
    relations: parseRelations(section(text, "Relations")),
    clauses: clauses.length ? clauses : decision ? [{ n: 1, text: decision }] : [],
  };
  const problems = formatProblems(text, adr, num, decision, clauses);
  return problems.length ? { ...adr, formatProblems: problems } : adr;
}

/** Where an ADR file departs from `templates/adr.md`. */
function formatProblems(text: string, adr: AdrRef, num: string, decision: string, clauses: AdrClause[]): string[] {
  const problems: string[] = [];
  const heading = text.match(/^#\s+(ADR-\d{4}): \S.*$/m);
  if (!heading) problems.push(`the first line must be "# ADR-${num}: <title>"`);
  else if (heading[1] !== `ADR-${num}`) problems.push(`the heading says ${heading[1]} but the file name says ADR-${num}`);
  if (!adr.date) problems.push('no "Date: YYYY-MM-DD" line under the title');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(adr.date)) problems.push(`the date "${adr.date}" is not YYYY-MM-DD`);
  const found = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!);
  if (found.join("|") !== SECTIONS.join("|")) problems.push(`sections must be ${SECTIONS.join(", ")}, in that order; found ${found.join(", ") || "none"}`);
  if (!/^(Proposed|Accepted|Superseded|Deprecated)\b/.test(section(text, "Status"))) {
    problems.push("Status must start with Proposed, Accepted, Superseded or Deprecated");
  }
  if (!clauses.length) problems.push("the Decision must be a numbered list of clauses");
  else {
    clauses.forEach((c, i) => c.n !== i + 1 && problems.push(`clause ${c.n} is out of order; number clauses 1, 2, 3 and so on`));
    const stray = decision.split("\n").find((l) => l.trim() && !/^\d+\.\s/.test(l) && !/^\s{2,}\S/.test(l));
    if (stray) problems.push(`the Decision holds text outside its numbered clauses: "${stray.trim().slice(0, 60)}"`);
  }
  const relations = section(text, "Relations");
  const strayRelation = relations.split("\n").find((l) => l.trim() && l.trim() !== "None." && !parseRelations(l).length);
  if (strayRelation) problems.push(`Relations holds a line that isn't a relation: "${strayRelation.trim().slice(0, 60)}"`);
  return problems;
}

/** "1. Rule" lines, each with any indented lines that follow it. */
export function parseClauses(decision: string): AdrClause[] {
  const clauses: AdrClause[] = [];
  for (const line of decision.split("\n")) {
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) clauses.push({ n: Number(m[1]), text: m[2]!.trim() });
    else if (clauses.length && /^\s{2,}\S/.test(line)) clauses[clauses.length - 1]!.text += ` ${line.trim()}`;
  }
  return clauses;
}

function section(text: string, name: string): string {
  return text.match(new RegExp(`^##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, "m"))?.[1]?.trim() ?? "";
}

function parseStatus(status: string): AdrStatus {
  const word = status.split(/\s/)[0]?.toLowerCase();
  return word === "accepted" || word === "superseded" || word === "deprecated" ? word : "proposed";
}

/** Lines such as "- Amends [ADR-0001](0001-name.md) clause 3: narrows the lint rule." */
export function parseRelations(block: string): AdrRelation[] {
  const kinds = [...RELATION_KINDS].sort((a, b) => b.length - a.length).join("|");
  const line = new RegExp(`^[-*]\\s*(${kinds})\\s+\\[?(ADR-\\d{4})\\]?(?:\\([^)]*\\))?\\s*(?:clauses?\\s+(\\d+(?:\\s*(?:,|and|&)\\s*\\d+)*))?`, "i");
  return block.split("\n").flatMap((l) => {
    const m = l.trim().match(line);
    if (!m) return [];
    const kind = RELATION_KINDS.find((k) => k.toLowerCase() === m[1]!.toLowerCase())!;
    return [{ kind, id: m[2]!.toUpperCase(), ...(m[3] ? { clauses: numbers(m[3]) } : {}) }];
  });
}

/** "ADR-0006: Title (amends ADR-0001 clause 2)", so a reader knows to take the two together. */
export function adrHeading(a: AdrRef): string {
  const notes = a.relations.filter((r) => r.kind === "Amends" || r.kind === "Amended by").map((r) => describeRelation(r).replace(/^A/, "a"));
  return `${a.id}: ${a.title}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * An ADR as a model reads it: the heading, then each clause by number. A
 * clause another ADR amends says so, so the reader looks there first.
 */
export function adrBrief(a: AdrRef): string {
  const amendedBy = (n: number) => a.relations.filter((r) => r.kind === "Amended by" && r.clauses?.includes(n)).map((r) => r.id);
  return [
    adrHeading(a),
    ...a.clauses.map((c) => {
      const by = amendedBy(c.n);
      return `${c.n}. ${c.text}${by.length ? ` [Amended by ${by.join(", ")}; that ADR's clauses take precedence here.]` : ""}`;
    }),
  ].join("\n");
}

// ── Writing ADRs ────────────────────────────────────────────────────────────

/** What a new ADR needs. Relations name the other ADR's file so the link works on GitHub. */
export type NewAdr = {
  id: string;
  title: string;
  date: string;
  status?: string;
  relations?: (AdrRelation & { file?: string; note?: string })[];
  context: string;
  clauses: string[];
  consequences: string;
};

/** The ADR template, `templates/adr.md`. */
export const adrTemplate = () => readFileSync(join(ENGINE_ROOT, "templates", "adr.md"), "utf8");

/** A new ADR in the project's format, from `templates/adr.md`. */
export function renderAdr(a: NewAdr): string {
  const relations = (a.relations ?? []).map((r) => {
    const link = r.file ? `[${r.id}](${r.file})` : r.id;
    const clauses = r.clauses?.length ? ` clause${r.clauses.length > 1 ? "s" : ""} ${r.clauses.join(", ")}` : "";
    return `- ${r.kind} ${link}${clauses}${r.note ? `: ${r.note}` : ""}`;
  });
  return render(adrTemplate(), {
    id: a.id,
    title: a.title,
    date: a.date,
    status: a.status ?? "Proposed",
    relations: relations.length ? relations.join("\n") : "None.",
    context: a.context.trim(),
    clauses: a.clauses.map((c, i) => `${i + 1}. ${c.trim()}`).join("\n"),
    consequences: a.consequences.trim(),
  });
}

/** The template with each slot explained, for a coding agent that must write an ADR by hand. */
export function adrTemplateGuide(): string {
  return render(adrTemplate(), {
    id: "ADR-NNNN (the next free number)",
    title: "<the decision, as a short statement>",
    date: "YYYY-MM-DD",
    status: "Proposed",
    relations:
      "- Amends [ADR-NNNN](NNNN-file.md) clause N: <what changes>\n" +
      '  (or "None.". Record each link on both ADRs: the amended ADR gets "- Amended by [ADR-MMMM](MMMM-file.md) clause N", with the same clause numbers.)',
    context: "<the forces at play and why a decision is needed>",
    clauses: "1. <one rule a reviewer can check>\n2. <the next rule>",
    consequences: "<what becomes easier or harder>",
  });
}
