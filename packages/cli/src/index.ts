#!/usr/bin/env -S npx tsx
/**
 * flows — run a flow against a project.
 *
 *   flows review  --repo <dir> [--diff-file f | --base main --head HEAD] [--task T-002]
 *   flows deliver --repo <dir> --task T-002 [--diff-file f] [--base main]
 *   flows plan    --repo <dir> --brief brief.md [--write]
 *   flows tasks   --repo <dir> [--done T-001,T-002]
 *   flows explain --repo <dir> --task T-002 [--diff-file f | --base main --head HEAD]
 *   flows adrs    --repo <dir>            ADR statuses and links, with broken links
 *   flows runs    [--repo <dir>]          paused runs
 *   flows resume  <run id>                pick a paused run up at its gate
 *
 * Common: [--artifacts <dir>] (shadow workspace) [--offline] [--claude-code] (every model on local Claude Code)
 *         [--yes] (auto-approve gates)
 *
 * Relative paths resolve against the directory you ran the command from, even
 * through `pnpm --dir <engine> flows …` (pnpm sets INIT_CWD to that directory).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  allAdrs,
  checkAdrs,
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
import {
  buildDeliveryGraph,
  registerDeliveryMocks,
  worktreeDiff,
  worktreePath,
  writeWalkthrough,
  type DeliveryState,
} from "@flows/delivery";
import { buildPlanningGraph, registerPlanningMocks, type PlanningState } from "@flows/planning";
import { buildReviewGraph, registerReviewMocks, type ReviewState } from "@flows/review";
import { drive, runWithProgress, type DriveResult } from "./drive";
import { checkpointer, findRun, openRuns, saveRun, type RunRecord } from "./runs";

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
    "claude-code": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

let command = positionals[0];
let here = process.env.INIT_CWD ?? process.cwd();
let resumed: RunRecord | undefined;

if (command === "runs") {
  const project = args.repo ? loadConfig(resolve(here, args.repo), args.artifacts && resolve(here, args.artifacts)).project : undefined;
  const runs = openRuns(project);
  if (!runs.length) console.log("No paused runs.");
  for (const r of runs) console.log(`${r.runId}  ${r.project}  ${r.status}${r.gate ? ` at ${r.gate}` : ""}`);
  process.exit(0);
}

if (command === "resume") {
  resumed = positionals[1] ? findRun(positionals[1]) : undefined;
  if (!resumed) {
    console.error(`usage: flows resume <run id>. ${positionals[1] ? `No run ${positionals[1]} under runs/.` : "flows runs lists paused runs."}`);
    process.exit(1);
  }
  Object.assign(args, resumed.args);
  command = resumed.command;
  here = resumed.here;
}

if (!command || !args.repo) {
  console.error("usage: flows <review|deliver|plan|tasks|adrs|explain|runs|resume> --repo <dir> [options]  (see packages/cli/src/index.ts)");
  process.exit(1);
}

const abs = (p: string | undefined) => (p === undefined ? undefined : resolve(here, p));
const config = loadConfig(abs(args.repo)!, abs(args.artifacts));

if (command === "adrs") {
  // No models needed: list the ADRs and check that every link is recorded on both sides.
  const adrs = allAdrs(config);
  for (const a of adrs) {
    const links = a.relations.map((r) => `${r.kind.toLowerCase()} ${r.id}`).join(", ");
    console.log(`${a.id} [${a.status}] ${a.title}${links ? `  · ${links}` : ""}`);
  }
  const problems = checkAdrs(adrs);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`\n${adrs.length} ADRs, links consistent.`);
  process.exit(0);
}

if (command === "tasks") {
  // No models needed: just show the task DAG and what's ready to pick up.
  const done = new Set((args.done ?? "").split(",").filter(Boolean));
  const all = loadTasks(config);
  const ready = new Set(readyTasks(all, done).map((t) => t.id));
  for (const t of all) console.log(`${done.has(t.id) ? "✔" : ready.has(t.id) ? "▶" : "·"} ${t.id} [${t.risk}] ${t.title}  ← ${t.dependsOn.join(", ") || "—"}`);
  process.exit(0);
}

const deps = createDeps(config, { offline: args.offline, claudeCode: args["claude-code"] });
registerReviewMocks(deps);
registerDeliveryMocks(deps);
registerPlanningMocks(deps);

const diffSource: DiffSource = args["diff-file"] ? { diffFile: abs(args["diff-file"])! } : { base: args.base!, head: args.head! };
const task = args.task ? findTask(config, args.task) : undefined;
if (args.task && !task) {
  console.error(`Task ${args.task} not found in ${config.artifactsDir}/plan/tasks.yaml`);
  process.exit(1);
}

const models = deps.offline ? " · OFFLINE (mocks)" : ` · models ${deps.backends.join("+") || "none"}`;
console.log(`▶ ${resumed ? "resume " : ""}${command} · project ${config.project} · judge ${deps.judge.name}${models}\n`);

/** Runs the review flow with the same progress lines as the gated flows, and returns its final state. */
function streamReview(input: unknown): Promise<unknown> {
  const graph = buildReviewGraph(deps);
  return runWithProgress({ stream: (i, c) => graph.stream(i, c) }, input, {}, (line) => console.log(line));
}

/**
 * Runs a gated graph with saved checkpoints. Returns the final state, or
 * undefined when you paused, after recording how to resume.
 */
async function runGated<S>(graph: Parameters<typeof drive>[0], input: unknown, runId: string): Promise<S | undefined> {
  const dir = runDir(config, runId);
  const record = { runId, project: config.project, command: command!, args, here };
  saveRun(dir, { ...record, status: "running" });
  const result: DriveResult<S> = await drive<S>(graph, resumed ? undefined : input, runId, {
    yes: args.yes!,
    gateStack: resumed?.gateStack,
  });
  if (result.status === "paused") {
    saveRun(dir, { ...record, status: "paused", gate: result.gate.gate, gateStack: result.gateStack });
    console.log(`\n⏸ paused at ${result.gate.gate}. Resume with: flows resume ${runId}`);
    return undefined;
  }
  saveRun(dir, { ...record, status: "done" });
  return result.values;
}

switch (command) {
  case "review": {
    const runId = newRunId("review");
    const label = task ? `${task.id} ${task.title}` : args["diff-file"] ?? `${args.base}...${args.head}`;
    const state = (await streamReview({ input: { diff: loadDiff(config, diffSource), task, label } })) as ReviewState;
    const path = writeRunFile(runDir(config, runId), "review.md", state.report ?? "");
    console.log(state.report);
    console.log(`\n📄 ${path}`);
    process.exitCode = state.verdict === "pass" ? 0 : 2;
    break;
  }

  case "deliver": {
    if (!task) throw new Error("deliver needs --task");
    const runId = resumed?.runId ?? newRunId(`deliver-${task.id}`);
    const graph = buildDeliveryGraph(deps, { checkpointer: checkpointer() });
    const final = await runGated<DeliveryState>(graph, { task, diffSource, base: args.base!, runId }, runId);
    if (!final) break;
    writeRunFile(runDir(config, runId), "state.json", JSON.stringify(final, null, 2));
    if (final.review?.report) writeRunFile(runDir(config, runId), "review.md", final.review.report);
    console.log(`\n■ outcome: ${final.outcome} after ${final.attempts} attempt(s) · cost $${totalCost(final.log).toFixed(4)}`);
    if (final.workdir) console.log(`🌿 branch flows/${task.id} in ${final.workdir}`);
    console.log(`📁 ${runDir(config, runId)}`);
    break;
  }

  case "plan": {
    if (!args.brief) throw new Error("plan needs --brief <file>");
    const runId = resumed?.runId ?? newRunId("plan");
    const graph = buildPlanningGraph(deps, {
      outDir: args.write ? config.artifactsDir : resolve(runDir(config, runId), "proposed"),
      detailDir: runDir(config, runId),
      checkpointer: checkpointer(),
    });
    const final = await runGated<PlanningState>(graph, { briefPath: abs(args.brief)! }, runId);
    if (!final) break;
    writeRunFile(runDir(config, runId), "state.json", JSON.stringify(final, null, 2));
    console.log(`\n■ planning ${final.emitted?.length ? "emitted" : "stopped"} · cost $${totalCost(final.log).toFixed(4)}`);
    for (const p of final.emitted ?? []) console.log(`  📄 ${p}`);
    break;
  }

  case "explain": {
    if (!task) throw new Error("explain needs --task");
    // Same diff delivery would review: the task's worktree if it has one, otherwise --diff-file or --base...--head.
    const worktree = worktreePath(config.project, task.id);
    const diff =
      !args["diff-file"] && existsSync(worktree) ? worktreeDiff(worktree, args.base!) : loadDiff(config, diffSource);
    const last = lastDelivery(task.id);
    const runId = newRunId(`explain-${task.id}`);
    const { walkthrough, log } = await writeWalkthrough(deps, { task, diff, runId, plan: last?.plan, review: last?.review });
    console.log(readFileSync(walkthrough.path, "utf8"));
    console.log(`\n📄 ${walkthrough.path} · cost $${(log.costUsd ?? 0).toFixed(4)}`);
    break;
  }

  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}

/** Plan and review from the task's latest delivery run, skipping offline runs, so a walkthrough can use them. */
function lastDelivery(taskId: string): Pick<DeliveryState, "plan" | "review"> | undefined {
  const root = resolve(ENGINE_ROOT, "runs", config.project);
  if (!existsSync(root)) return undefined;
  const states = readdirSync(root)
    .filter((d) => d.endsWith(`-deliver-${taskId}`) && existsSync(resolve(root, d, "state.json")))
    .sort()
    .reverse()
    .map((d) => JSON.parse(readFileSync(resolve(root, d, "state.json"), "utf8")) as DeliveryState);
  return states.find((s) => !s.log.some((e) => e.model?.startsWith("mock:")));
}
