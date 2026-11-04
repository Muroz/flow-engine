/**
 * The `diff-file` agent: it writes no code, it replays a fixed diff.
 *
 * It applies the diff in the task's worktree, the same one the Claude Code
 * agent uses, so checks and the merge act on the change instead of on
 * whatever the repo has checked out.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ensureWorktree, worktreePath } from "./claude-code";

/**
 * Applies `diff` to a clean worktree on `flows/<task>` and returns its path.
 * Every attempt starts from the branch's last commit, so a replay never
 * stacks on the one before. Files listed in `copy`, such as `.env`, survive.
 */
export function replayDiff(repo: string, project: string, taskId: string, base: string, diff: string, copy: string[] = []): string {
  const existing = worktreePath(project, taskId);
  if (existsSync(existing)) {
    const git = (...args: string[]) => execFileSync("git", ["-C", existing, ...args], { stdio: "pipe" });
    git("reset", "-q", "--hard");
    git("clean", "-fdq", ...copy.flatMap((file) => ["-e", file]));
  }
  const dir = ensureWorktree(repo, project, taskId, base, copy);
  if (!diff.trim()) return dir;
  try {
    execFileSync("git", ["-C", dir, "apply", "--index", "--whitespace=nowarn"], { input: diff, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    const why = String(e.stderr || e.message).trim().split("\n")[0];
    throw new Error(`The diff doesn't apply to ${base}: ${why}`);
  }
  return dir;
}
