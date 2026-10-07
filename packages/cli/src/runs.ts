/**
 * Run records: `run.json` in each run folder holds what `flows resume` needs
 * to rebuild a run, and what `flows runs` lists.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "@flows/core";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export type RunRecord = {
  runId: string;
  project: string;
  command: string;
  /** Parsed CLI arguments, with `here` to resolve relative paths the same way. */
  args: Record<string, unknown>;
  here: string;
  status: "running" | "paused" | "done";
  /** The gate a paused run waits at. */
  gate?: string;
  gateStack?: { configurable?: Record<string, unknown> }[];
  updatedAt: string;
};

const RUNS = join(ENGINE_ROOT, "runs");

/** Every gated run's checkpoints, in one file under the git-ignored runs folder. */
export const checkpointer = () => SqliteSaver.fromConnString(join(RUNS, "checkpoints.db"));

export function saveRun(dir: string, record: Omit<RunRecord, "updatedAt">): void {
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2));
}

export function findRun(runId: string): RunRecord | undefined {
  if (!existsSync(RUNS)) return undefined;
  for (const project of readdirSync(RUNS)) {
    const file = join(RUNS, project, runId, "run.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  }
  return undefined;
}

/** Runs that can be resumed, newest first. */
export function openRuns(project?: string): RunRecord[] {
  if (!existsSync(RUNS)) return [];
  const projects = project ? [project] : readdirSync(RUNS);
  return projects
    .flatMap((p) => {
      const dir = join(RUNS, p);
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map((id) => join(dir, id, "run.json")).filter(existsSync);
    })
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as RunRecord)
    .filter((r) => r.status !== "done")
    .sort((a, b) => b.runId.localeCompare(a.runId));
}
