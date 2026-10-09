/**
 * The worktree helpers against a throwaway git repo. No agent runs here:
 * the test edits the worktree itself, the way an agent would.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ENGINE_ROOT } from "@flows/core";
import { agentModel, describeEvent, ensureWorktree, snapshotTree, treeDiff, worktreeDiff } from "../src/agents/claude-code";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "flows-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

test("ensureWorktree creates one worktree per task and reuses it; worktreeDiff shows the agent's changes", (t) => {
  const repo = tempRepo();
  const project = `test-${process.pid}`;
  t.after(() => {
    rmSync(join(ENGINE_ROOT, "runs", project), { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const dir = ensureWorktree(repo, project, "T-001", "main");
  assert.equal(dir, join(ENGINE_ROOT, "runs", project, "worktrees", "T-001"));
  assert.equal(git(dir, "branch", "--show-current").trim(), "flows/T-001");
  assert.equal(ensureWorktree(repo, project, "T-001", "main"), dir);

  writeFileSync(join(dir, "a.txt"), "two\n");
  writeFileSync(join(dir, "b.txt"), "new\n");
  const diff = worktreeDiff(dir, "main");
  assert.match(diff, /^-one$/m);
  assert.match(diff, /^\+two$/m);
  assert.match(diff, /^\+\+\+ b\/b\.txt$/m);

  // The main checkout is untouched.
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("ensureWorktree refuses a folder inside a repo, so it never branches the wrong repository", (t) => {
  const repo = tempRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "sub"));
  assert.throws(() => ensureWorktree(join(repo, "sub"), "x", "T-001", "main"), /root of a git repository/);
});

test("agentModel takes the model from a claude-code/ implementer, else from claudeCode.model", () => {
  assert.equal(agentModel("claude-code/opus"), "opus");
  assert.equal(agentModel("claude-code/default"), undefined);
  assert.equal(agentModel("anthropic/claude-sonnet-5.5"), undefined);
  assert.equal(agentModel(undefined), undefined);
  assert.equal(agentModel("anthropic/claude-sonnet-5.5", "opus"), "opus", "claudeCode.model applies when implementer isn't a claude-code model");
  assert.equal(agentModel("claude-code/sonnet", "opus"), "sonnet");
});

test("describeEvent prints one line per tool call, with paths inside the worktree", () => {
  const event = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", name: "Edit", input: { file_path: "/w/T-001/src/app/page.tsx" } },
        { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
      ],
    },
  };
  assert.deepEqual(describeEvent(event, ["/w/T-001"]), ["Edit src/app/page.tsx", "Bash pnpm test"]);
  assert.deepEqual(describeEvent({ type: "result" }), []);
});

test("ensureWorktree copies listed untracked files, such as .env, into the worktree", (t) => {
  const repo = tempRepo();
  const project = `test-copy-${process.pid}`;
  t.after(() => {
    rmSync(join(ENGINE_ROOT, "runs", project), { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  writeFileSync(join(repo, ".env"), "DATABASE_URL=postgres://local\n");
  const dir = ensureWorktree(repo, project, "T-001", "main", [".env", "missing.txt"]);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "DATABASE_URL=postgres://local\n");
  assert.ok(!existsSync(join(dir, "missing.txt")));

  writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://local\nEXTRA=agent\n");
  ensureWorktree(repo, project, "T-001", "main", [".env"]);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /EXTRA=agent/, "a copy the agent changed is kept");
});

test("snapshots leave the worktree alone and show what changed between rounds", (t) => {
  const repo = tempRepo();
  const project = `test-snap-${process.pid}`;
  t.after(() => {
    rmSync(join(ENGINE_ROOT, "runs", project), { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  const dir = ensureWorktree(repo, project, "T-001", "main");

  writeFileSync(join(dir, "a.txt"), "round one\n");
  worktreeDiff(dir, "main");
  const status = git(dir, "status", "--porcelain");
  const head = git(dir, "rev-parse", "HEAD");
  const first = snapshotTree(dir);
  assert.equal(git(dir, "status", "--porcelain"), status, "snapshot changes nothing in the worktree or index");
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "snapshot makes no commit");

  writeFileSync(join(dir, "b.txt"), "round two\n");
  worktreeDiff(dir, "main");
  const second = snapshotTree(dir);
  const delta = treeDiff(dir, first, second);
  assert.match(delta, /^\+\+\+ b\/b\.txt$/m);
  assert.doesNotMatch(delta, /round one/, "the delta leaves out what the last round already saw");
});
