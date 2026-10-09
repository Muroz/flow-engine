/**
 * Artifact I/O. Flows talk to each other only through these files:
 *
 *   <artifactsDir>/docs/prd.md          planning → everyone
 *   <artifactsDir>/docs/adr/*.md        planning → delivery, review
 *   <artifactsDir>/plan/tasks.yaml      planning → delivery
 *   <engine>/runs/<project>/<runId>/    per-run outputs (never in the client repo)
 *
 * Rule of thumb: state carries a *reference* plus a short summary; nodes load
 * the full artifact only when they actually need it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { ProjectConfig, StandardRef } from "./config";
import type { PlannedTask } from "./types";

// ── Tasks ───────────────────────────────────────────────────────────────────

export function loadTasks(config: ProjectConfig): PlannedTask[] {
  const file = join(config.artifactsDir, "plan", "tasks.yaml");
  if (!existsSync(file)) return [];
  const raw = YAML.parse(readFileSync(file, "utf8")) ?? {};
  const list: any[] = Array.isArray(raw) ? raw : (raw.tasks ?? []);
  return list.map((t) => ({
    id: String(t.id),
    title: String(t.title ?? ""),
    requirementIds: t.requirementIds ?? [],
    adrRefs: t.adrRefs ?? [],
    dependsOn: t.dependsOn ?? [],
    acceptanceCriteria: t.acceptanceCriteria ?? [],
    risk: t.risk ?? "medium",
    estimate: t.estimate,
  }));
}

export function findTask(config: ProjectConfig, id: string): PlannedTask | undefined {
  return loadTasks(config).find((t) => t.id === id);
}

/** Tasks whose dependencies are all in `done` — i.e. what delivery can pick up next. */
export function readyTasks(tasks: PlannedTask[], done: Set<string>): PlannedTask[] {
  return tasks.filter((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d)));
}

// ── Standards & PRD ──────────────────────────────────────────────────────────────

export type Standard = StandardRef & { text: string };

/** The project's standards files with their text. A missing file is skipped with a warning. */
export function loadStandards(config: ProjectConfig): Standard[] {
  return config.standards.flatMap((ref) => {
    const file = resolve(config.artifactsDir, ref.path);
    if (!existsSync(file)) {
      console.warn(`standards: ${ref.path} not found in ${config.artifactsDir}, skipped`);
      return [];
    }
    return [{ ...ref, text: readFileSync(file, "utf8") }];
  });
}

export function loadPrd(config: ProjectConfig): { path: string; text: string } | undefined {
  const path = join(config.artifactsDir, "docs", "prd.md");
  return existsSync(path) ? { path, text: readFileSync(path, "utf8") } : undefined;
}

// ── Diffs ───────────────────────────────────────────────────────────────────

export type DiffSource = { diffFile: string } | { base: string; head: string };

export function loadDiff(config: ProjectConfig, source: DiffSource): string {
  if ("diffFile" in source) return readFileSync(resolve(source.diffFile), "utf8");
  return execFileSync("git", ["-C", config.repoDir, "diff", `${source.base}...${source.head}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** One entry per file in a unified diff. */
export function splitDiff(diff: string): { file: string; text: string }[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((text) => ({ file: text.match(/^diff --git a\/\S+ b\/(\S+)/)?.[1] ?? "", text }));
}

/**
 * Drops files no reviewer should read, such as lockfiles and build output.
 * A pattern without a slash matches the file name in any folder.
 */
export function filterDiff(diff: string, ignore: string[]): { diff: string; skipped: string[] } {
  const rules = ignore.map((p) => ({ re: globToRegExp(p), name: !p.includes("/") }));
  const ignored = (file: string) => rules.some((r) => r.re.test(r.name ? file.split("/").pop()! : file));
  const parts = splitDiff(diff);
  if (!parts.length) return { diff, skipped: [] };
  return {
    diff: parts.filter((p) => !ignored(p.file)).map((p) => p.text).join(""),
    skipped: parts.filter((p) => ignored(p.file)).map((p) => p.file),
  };
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${re}$`);
}

export function changedFiles(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!).filter((f) => f !== "/dev/null");
}

// ── Run outputs ─────────────────────────────────────────────────────────────

/** Root of this engine checkout (…/flow-engine). */
export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function newRunId(flow: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${flow}`;
}

/** Per-run output folder, partitioned by project so client work never mixes. */
export function runDir(config: ProjectConfig, runId: string): string {
  const dir = join(ENGINE_ROOT, "runs", config.project, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeRunFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// ── Writers (used by the planning flow's emit step) ─────────────────────────

export function writeTasksYaml(dir: string, tasks: PlannedTask[]): string {
  return writeRunFile(dir, "plan/tasks.yaml", YAML.stringify({ tasks }));
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}
