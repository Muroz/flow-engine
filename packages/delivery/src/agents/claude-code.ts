/**
 * Claude Code as the coding agent behind `implement`.
 *
 * Each task gets its own git worktree on branch `flows/<task>`, so attempts
 * never touch your main checkout. The agent runs headless with a fixed tool
 * allow-list; delivery reads the result back as a diff against the base.
 *
 * Any headless agent fits the same three functions. To use another one,
 * replace `runClaudeCode`.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAUDE_CODE_PREFIX, ENGINE_ROOT, isClaudeCodeModel } from "@flows/core";

/** Read-only and edit tools the agent always gets. Checks are added per project. */
export const BASE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

/**
 * Create (or reuse) the worktree for a task under the engine's `runs/` folder,
 * which is git-ignored and never inside the project repo.
 */
export function ensureWorktree(repo: string, project: string, taskId: string, base: string, copy: string[] = []): string {
  const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (realpathSync(top) !== realpathSync(repo)) {
    throw new Error(`--repo must be the root of a git repository (got ${repo}, root is ${top}).`);
  }
  const dir = worktreePath(project, taskId);
  if (!existsSync(dir)) {
    execFileSync("git", ["-C", repo, "worktree", "add", "-B", `flows/${taskId}`, dir, base], { stdio: "pipe" });
  }
  // Untracked files such as .env never reach a new worktree, so the checks would run without them.
  // An existing copy is kept, since the agent may have added variables to it.
  for (const file of copy) {
    const from = join(repo, file);
    const to = join(dir, file);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
  return dir;
}

/**
 * The `--model` value for the agent: the part after `claude-code/` in
 * `models.implementer`, or else `claudeCode.model`. "default" leaves the
 * choice to Claude Code.
 */
export function agentModel(implementer: string | undefined, fallback = "default"): string | undefined {
  const alias = implementer && isClaudeCodeModel(implementer) ? implementer.slice(CLAUDE_CODE_PREFIX.length) : fallback;
  return alias && alias !== "default" ? alias : undefined;
}

export function worktreePath(project: string, taskId: string): string {
  return join(ENGINE_ROOT, "runs", project, "worktrees", taskId);
}

export type AgentRun = {
  /** Claude Code's final result message, as JSON. */
  result: string;
  /** Every event Claude Code streamed, one JSON object per line. */
  events: string;
  costUsd?: number;
};

/**
 * Runs Claude Code headless in `workdir` and calls `onStep` with a short line
 * for each tool it uses, such as "Edit src/app/page.tsx", so you can follow along.
 */
export function runClaudeCode(
  workdir: string,
  prompt: string,
  allowedTools: string[],
  model: string | undefined,
  onStep: (line: string) => void = () => {},
): Promise<AgentRun> {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", allowedTools.join(","),
    ...(model ? ["--model", model] : []),
  ];
  // Claude Code reports absolute paths, sometimes through /private on macOS.
  const roots = [workdir, realpathSync(workdir)];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60_000 });
    let events = "";
    let pending = "";
    let result = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      events += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const event = parseEvent(line);
        if (event?.type === "result") result = line;
        for (const step of describeEvent(event, roots)) onStep(step);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (!result) return reject(new Error(`claude exited with ${code} and no result: ${stderr.slice(0, 500)}`));
      resolve({ result, events, costUsd: parseEvent(result)?.total_cost_usd });
    });
  });
}

function parseEvent(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** One line per tool call in an assistant message, with paths relative to the worktree. */
export function describeEvent(event: any, roots: string[] = []): string[] {
  if (event?.type !== "assistant") return [];
  return (event.message?.content ?? [])
    .filter((c: any) => c.type === "tool_use")
    .map((c: any) => {
      const target = c.input?.file_path ?? c.input?.command ?? c.input?.pattern ?? c.input?.path ?? "";
      const short = roots.reduce((t, root) => t.split(`${root}/`).join(""), String(target));
      return `${c.name} ${short}`.trim();
    });
}

/** Everything the agent changed in `workdir`, staged, as a diff against `base`. */
export function worktreeDiff(workdir: string, base: string): string {
  execFileSync("git", ["-C", workdir, "add", "-A"]);
  return execFileSync("git", ["-C", workdir, "diff", "--cached", base], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

export type MergeResult = { commit?: string; merged: boolean; why?: string };

/**
 * Commits the task's worktree on `flows/<task>`, then fast-forwards `base` in
 * `repo` to it. A base that moved on, or a dirty checkout of it, stops short
 * of the merge and says why; the commit stays on the branch either way.
 */
export function mergeWorktree(repo: string, workdir: string, taskId: string, base: string, message: string): MergeResult {
  const branch = `flows/${taskId}`;
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  let commit: string | undefined;
  try {
    run(workdir, "add", "-A");
    if (run(workdir, "diff", "--cached", "--name-only")) run(workdir, "commit", "-q", "-m", message);
    commit = run(workdir, "rev-parse", "HEAD");
    if (run(repo, "branch", "--show-current") === base) {
      if (run(repo, "status", "--porcelain", "--untracked-files=no")) {
        return { commit, merged: false, why: `${base} is checked out in ${repo} with uncommitted changes` };
      }
      run(repo, "merge", "-q", "--ff-only", branch);
    } else {
      // Fetching into a local branch only ever fast-forwards it.
      run(repo, "fetch", "-q", ".", `${branch}:${base}`);
    }
    return { commit, merged: true };
  } catch (e: any) {
    const why = String(e.stderr || e.message).trim().split("\n")[0];
    return { commit, merged: false, why };
  }
}

/**
 * Why each of the task's dependencies is not yet in `base`, if any is not.
 * A dependency is missing when its worktree still holds uncommitted work, or
 * when its `flows/<dep>` branch is not an ancestor of `base`. One with neither
 * a worktree nor a branch counts as done outside flows.
 */
export function unmetDependencies(repo: string, project: string, dependsOn: string[], base: string): string[] {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });
  const ok = (cwd: string, ...args: string[]) => {
    try {
      git(cwd, ...args);
      return true;
    } catch {
      return false;
    }
  };
  const unmet: string[] = [];
  for (const dep of dependsOn) {
    const dir = worktreePath(project, dep);
    if (existsSync(dir) && git(dir, "status", "--porcelain").trim()) {
      unmet.push(`${dep}: its worktree has uncommitted work (${dir})`);
    } else if (ok(repo, "rev-parse", "--verify", "-q", `refs/heads/flows/${dep}`) && !ok(repo, "merge-base", "--is-ancestor", `flows/${dep}`, base)) {
      unmet.push(`${dep}: branch flows/${dep} is not merged into ${base}`);
    }
  }
  return unmet;
}

/**
 * The git tree of everything `worktreeDiff` staged. Writing a tree object
 * leaves the worktree, the index and the branch as they are.
 */
export function snapshotTree(workdir: string): string {
  return execFileSync("git", ["-C", workdir, "write-tree"], { encoding: "utf8" }).trim();
}

/** What changed between two snapshots. */
export function treeDiff(workdir: string, from: string, to: string): string {
  return execFileSync("git", ["-C", workdir, "diff", from, to], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
