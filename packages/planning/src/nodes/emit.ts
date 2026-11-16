import { join } from "node:path";
import { logEntry, renderAdr as renderAdrFile, slugify, writeRunFile, writeTasksYaml } from "@flows/core";
import type { DraftAdr, PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";
import { reqList } from "./shared";

/**
 * Deterministic. Writes the artifacts delivery and review consume: the PRD,
 * one file per ADR and tasks.yaml. `outDir` is a proposal folder unless you
 * pass --write.
 *
 * Reads `brief`, `requirements`, `chosen`, `adrs` and `tasks`. Writes
 * `emitted`, the paths it wrote.
 */
export const emit = (outDir: string) => async (s: PlanningState): Promise<PlanningUpdate> => {
  const prd = [
    "# PRD",
    "",
    "## Brief",
    s.brief ?? "",
    "",
    "## Requirements",
    reqList(mvp(s.requirements)),
    "",
    "## Later",
    reqList(s.requirements.filter((r) => r.priority === "later")) || "(none)",
    "",
    "## Architecture",
    `${s.chosen?.summary ?? ""}`,
  ].join("\n");
  const files = [writeRunFile(outDir, "docs/prd.md", prd)];
  // Local date, so an ADR written in the evening carries the day you approved it.
  const date = new Date().toLocaleDateString("en-CA");
  for (const a of s.adrs) files.push(writeRunFile(outDir, join("docs/adr", adrFileName(a)), renderAdr(a, s.adrs, date)));
  files.push(writeTasksYaml(outDir, s.tasks));
  return { emitted: files, log: [logEntry("planning.emit", { note: `${files.length} files → ${outDir}` })] };
};

/** The ADR's file name, such as `0001-use-postgres.md`. */
const adrFileName = (a: DraftAdr) => `${a.id.slice(4)}-${slugify(a.title)}.md`;

/**
 * A new ADR from `templates/adr.md`, dated `date`. "Related to" links are
 * written on both ADRs, whichever one the model listed them under.
 */
export function renderAdr(a: DraftAdr, all: DraftAdr[], date: string): string {
  const byId = new Map(all.map((x) => [x.id, x]));
  const related = new Set([
    ...(a.related ?? []),
    ...all.filter((x) => x.related?.includes(a.id)).map((x) => x.id),
  ]);
  related.delete(a.id);
  return renderAdrFile({
    id: a.id,
    title: a.title,
    date,
    relations: [...related]
      .filter((id) => byId.has(id))
      .sort()
      .map((id) => ({ kind: "Related to" as const, id, file: adrFileName(byId.get(id)!) })),
    context: a.context,
    clauses: a.clauses,
    consequences: a.consequences,
  });
}
