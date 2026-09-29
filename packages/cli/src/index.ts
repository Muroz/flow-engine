#!/usr/bin/env -S npx tsx
/**
 * flows — run a flow against a project.
 *
 *   flows review  --repo <dir> [--diff-file f | --base main --head HEAD] [--task T-002]
 *   flows deliver --repo <dir> --task T-002 [--diff-file f] [--base main]
 *   flows plan    --repo <dir> --brief brief.md [--write]
 *   flows tasks   --repo <dir> [--done T-001,T-002]
 *
 * Common: [--artifacts <dir>] (shadow workspace) [--offline] [--yes] (auto-approve gates)
 *
 * Relative paths resolve against the directory you ran the command from, even
 * through `pnpm --dir <engine> flows …` (pnpm sets INIT_CWD to that directory).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createDeps,
  ENGINE_ROOT,
  findTask,
  loadConfig,
  loadDiff,
  loadTasks,
  newRunId,
  readyTasks,
  runDir,
  totalCost,
  writeRunFile,
  type DiffSource,
} from "@flows/core";
import { buildDeliveryGraph, registerDeliveryMocks, type DeliveryState } from "@flows/delivery";
import { buildPlanningGraph, registerPlanningMocks, type PlanningState } from "@flows/planning";
import { registerReviewMocks, runReview } from "@flows/review";
import { drive } from "./drive";

// Load .env from the engine root if present (Node ≥ 20.12).
const envFile = resolve(ENGINE_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile?.(envFile);

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    artifacts: { type: "string" },
    "diff-file": { type: "string" },
    base: { type: "string", default: "main" },
    head: { type: "string", default: "HEAD" },
    task: { type: "string" },
    brief: { type: "string" },
    done: { type: "string" },
    write: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const command = positionals[0];
if (!command || !args.repo) {
  console.error("usage: flows <review|deliver|plan|tasks> --repo <dir> [options]  (see packages/cli/src/index.ts)");
  process.exit(1);
}

const here = process.env.INIT_CWD ?? process.cwd();
const abs = (p: string | undefined) => (p === undefined ? undefined : resolve(here, p));
const config = loadConfig(abs(args.repo)!, abs(args.artifacts));

if (command === "tasks") {
  // No models needed: just show the task DAG and what's ready to pick up.
  const done = new Set((args.done ?? "").split(",").filter(Boolean));
  const all = loadTasks(config);
  const ready = new Set(readyTasks(all, done).map((t) => t.id));
  for (const t of all) console.log(`${done.has(t.id) ? "✔" : ready.has(t.id) ? "▶" : "·"} ${t.id} [${t.risk}] ${t.title}  ← ${t.dependsOn.join(", ") || "—"}`);
  process.exit(0);
}

const deps = createDeps(config, { offline: args.offline });
registerReviewMocks(deps);
registerDeliveryMocks(deps);
registerPlanningMocks(deps);

const diffSource: DiffSource = args["diff-file"] ? { diffFile: abs(args["diff-file"])! } : { base: args.base!, head: args.head! };
const task = args.task ? findTask(config, args.task) : undefined;
if (args.task && !task) {
  console.error(`Task ${args.task} not found in ${config.artifactsDir}/plan/tasks.yaml`);
  process.exit(1);
}

console.log(`▶ ${command} · project ${config.project} · judge ${deps.judge.name}${deps.offline ? " · OFFLINE (mocks)" : ""}\n`);

switch (command) {
  case "review": {
    const runId = newRunId("review");
    const label = task ? `${task.id} ${task.title}` : args["diff-file"] ?? `${args.base}...${args.head}`;
    const state = await runReview(deps, { diff: loadDiff(config, diffSource), task, label });
    const path = writeRunFile(runDir(config, runId), "review.md", state.report ?? "");
    console.log(state.report);
    console.log(`\n📄 ${path}`);
    process.exitCode = state.verdict === "pass" ? 0 : 2;
    break;
  }

  case "deliver": {
    if (!task) throw new Error("deliver needs --task");
    const runId = newRunId(`deliver-${task.id}`);
    const graph = buildDeliveryGraph(deps);
    const final = await drive<DeliveryState>(graph, { task, diffSource, base: args.base!, runId }, runId, { yes: args.yes });
    writeRunFile(runDir(config, runId), "state.json", JSON.stringify(final, null, 2));
    if (final.review?.report) writeRunFile(runDir(config, runId), "review.md", final.review.report);
    console.log(`\n■ outcome: ${final.outcome} after ${final.attempts} attempt(s) · cost $${totalCost(final.log).toFixed(4)}`);
    if (final.workdir) console.log(`🌿 branch flows/${task.id} in ${final.workdir}`);
    console.log(`📁 ${runDir(config, runId)}`);
    break;
  }

  case "plan": {
    if (!args.brief) throw new Error("plan needs --brief <file>");
    const runId = newRunId("plan");
    const graph = buildPlanningGraph(deps, { outDir: args.write ? config.artifactsDir : resolve(runDir(config, runId), "proposed") });
    const final = await drive<PlanningState>(graph, { briefPath: abs(args.brief)! }, runId, { yes: args.yes });
    writeRunFile(runDir(config, runId), "state.json", JSON.stringify(final, null, 2));
    console.log(`\n■ planning ${final.emitted?.length ? "emitted" : "stopped"} · cost $${totalCost(final.log).toFixed(4)}`);
    for (const p of final.emitted ?? []) console.log(`  📄 ${p}`);
    break;
  }

  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}
