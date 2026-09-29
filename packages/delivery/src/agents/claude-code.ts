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
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "@flows/core";

/** Read-only and edit tools the agent always gets. Checks are added per project. */
export const BASE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

/**
 * Create (or reuse) the worktree for a task under the engine's `runs/` folder,
 * which is git-ignored and never inside the project repo.
 */
export function ensureWorktree(repo: string, project: string, taskId: string, base: string): string {
  const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (realpathSync(top) !== realpathSync(repo)) {
    throw new Error(`--repo must be the root of a git repository (got ${repo}, root is ${top}).`);
  }
  const dir = join(ENGINE_ROOT, "runs", project, "worktrees", taskId);
  if (!existsSync(dir)) {
    execFileSync("git", ["-C", repo, "worktree", "add", "-B", `flows/${taskId}`, dir, base], { stdio: "pipe" });
  }
  return dir;
}

/** Run Claude Code headless in `workdir`. Returns its JSON transcript. */
export function runClaudeCode(workdir: string, prompt: string, allowedTools: string[]): string {
  return execFileSync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", allowedTools.join(",")],
    { cwd: workdir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 },
  );
}

/** Everything the agent changed in `workdir`, staged, as a diff against `base`. */
export function worktreeDiff(workdir: string, base: string): string {
  execFileSync("git", ["-C", workdir, "add", "-A"]);
  return execFileSync("git", ["-C", workdir, "diff", "--cached", base], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}
