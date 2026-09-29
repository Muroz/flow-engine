# Wiring it up

Work through this in order. Each stage is useful on its own, so you can stop anywhere and still have something working.

| Stage | You get | Effort |
|---|---|---|
| 0. Verify | Confidence the scaffold runs on your machine | 5 min |
| 1. Keys + real review | AI code review on any branch, yours or a client's | 30 min |
| 2. Review in CI | Review on every PR, with a digest comment | 1 h |
| 3. Coding agent in `implement` | Delivery actually writes code | half a day |
| 4. Persistent runs + remote gates | Approve from your phone; runs survive restarts | half a day |
| 5. PRs, tracing, evals | The loop closes; you can measure and tune it | ongoing |

---

## 0. Verify

```bash
cd ~/Coding/flow-engine
bash scripts/verify.sh
```

This installs dependencies, type-checks, runs the unit tests and all three sample flows offline, then writes `runs/verify.log`.

**What "good" looks like:**
- Every step shows `exit 0`, except the review step, which exits `2` (the sample diff is deliberately bad).
- deliver ends with `outcome: escalated after 3 attempt(s)`.
- plan ends with `planning emitted` and lists 4 files.

---

## 1. Keys and a real review

1. Copy the env file: `cp .env.example .env`.
2. Add your keys:
   - `OPENROUTER_API_KEY`
   - optionally `TYPESAFE_API_KEY` for Jev. Without it, judges fall back to an LLM judge through OpenRouter, which is slower and costs more.
3. Fix the model slugs in `.flows.yaml` (see openrouter.ai/models). Keep `reviewer` on a different vendor from `default`/`implementer`.
4. Run the live smoke test: `bash scripts/verify.sh --live`.
5. Review a real branch of your own:

```bash
pnpm flows review --repo ~/Coding/<project> --base main --head <branch>
```

With no `.flows.yaml` in the project, you get defaults: no ADRs, no conventions, and no spec reviewer. The spec reviewer only runs when there's a task.

To get more useful reviews, add a `.flows.yaml`, a few ADRs under `docs/adr/`, and conventions. Then architecture review has something to check against.

### Client repos (shadow workspace)

Client repos keep their code in their own checkout. Everything the flows need lives in a workspace folder you own:

```
~/Coding/workspaces/<client>/
  .flows.yaml        # models, openrouter.provider per the client's AI policy
  docs/adr/…
  plan/tasks.yaml
```

Point the review at both:

```bash
pnpm flows review --repo ~/Coding/<client-repo> --artifacts ~/Coding/workspaces/<client> --base main --head feature-x
```

Before sending a client's code anywhere, confirm their policy. Then restrict providers in that workspace's config:

```yaml
openrouter:
  provider:
    data_collection: deny
    only: [anthropic]  # whatever the client allows
```

### Tuning the judge

These settings live in `review:` in `.flows.yaml`:

- **`minConfidence`** (default 0.6): raise it if reviews are noisy, lower it if they miss things.
- **`dropSeverities`**: add `minor` if you only want blocking issues.
- **`escalateAtSeverity`**: `major` makes the flow ask you more often.

After a few real runs, compare the `review.triage` log lines between Jev and the LLM judge. That comparison is where Jev's speed and cost show up.

---

## 2. Review on every PR (GitHub Actions)

Add this to the project repo (or run the equivalent on your machine with `gh`):

```yaml
# .github/workflows/flows-review.yml
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/checkout@v4
        with: { repository: <you>/flow-engine, path: .flow-engine, token: ${{ secrets.FLOW_ENGINE_TOKEN }} }
      - uses: pnpm/action-setup@v4
      - run: cd .flow-engine && pnpm install --frozen-lockfile
      - run: |
          cd .flow-engine
          pnpm flows review --repo "$GITHUB_WORKSPACE" \
            --base "origin/${{ github.base_ref }}" --head HEAD | tee ../review.txt
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
      - if: always()
        run: gh pr comment ${{ github.event.number }} --body-file review.txt
        env: { GH_TOKEN: ${{ github.token }} }
```

`flows review` exits `2` when the verdict isn't `pass`, so the job fails on blockers. For **client** repos, run this from your own machine or CI rather than theirs. That keeps your engine private.

---

## 3. Plug a coding agent into `implement`

`packages/delivery/src/nodes.ts → implement` is the stub. The shape of a real one:

1. **Isolate:** one git worktree and branch per task, so attempts never touch your main checkout.
2. **Prompt:** the task, the plan, the ADR decisions, and `fixNotes` from the last checks or review.
3. **Run the agent headless** with a tight tool allow-list.
4. **Read back the diff.** Store the agent's transcript as a run file; put only the diff in state.

```ts
// packages/delivery/src/agents/claude-code.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function ensureWorktree(repo: string, taskId: string, base = "main"): string {
  const dir = join(repo, "..", ".flows-worktrees", taskId);
  if (!existsSync(dir)) {
    execFileSync("git", ["-C", repo, "worktree", "add", "-B", `flows/${taskId}`, dir, base]);
  }
  return dir;
}

export function runClaudeCode(workdir: string, prompt: string): { transcript: string } {
  const out = execFileSync(
    "claude",
    [
      "-p", prompt,
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(pnpm test:*),Bash(pnpm lint:*)",
    ],
    { cwd: workdir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 },
  );
  return { transcript: out };
}

export function worktreeDiff(workdir: string, base = "main"): string {
  execFileSync("git", ["-C", workdir, "add", "-A"]);
  return execFileSync("git", ["-C", workdir, "diff", "--cached", base], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}
```

Then, in `implement`:

```ts
const workdir = ensureWorktree(deps.config.repoDir, s.task.id);
const prompt = [
  `Implement ${s.task.id}: ${s.task.title}`,
  `Acceptance criteria:\n${s.task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
  `Plan:\n${s.plan!.steps.map((x) => `- ${x}`).join("\n")}`,
  s.fixNotes.length ? `Fix these from the last attempt:\n${s.fixNotes.join("\n")}` : "",
  "Respect the ADRs in docs/adr. Add or update tests. Do not commit.",
].join("\n\n");
const { transcript } = runClaudeCode(workdir, prompt);
writeRunFile(runDir(deps.config, s.runId), `agent-attempt-${s.attempts + 1}.json`, transcript);
return { attempts: s.attempts + 1, diff: worktreeDiff(workdir), workdir, log: [ … ] };
```

Two follow-up changes:

- **Add `workdir` to `DeliveryState` and the Annotation.** Make `runChecks` run in `s.workdir` instead of `config.repoDir`, so checks test the agent's code.
- **Keep the diff-file path behind a flag.** For example, `delivery.agent: claude-code | diff-file` in `.flows.yaml`. Offline runs and tests then keep working.

Any headless agent fits the same three functions. To use another agent, swap `runClaudeCode`.

---

## 4. Persistent runs and gates away from the terminal

Today, gates block the CLI process (`MemorySaver`, readline). To approve from your phone:

**1. Persist checkpoints.**

```bash
pnpm --filter @flows/delivery add @langchain/langgraph-checkpoint-sqlite
```

```ts
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
.compile({ checkpointer: SqliteSaver.fromConnString(join(ENGINE_ROOT, "runs", "checkpoints.db")) })
```

**2. Split `drive` into start and resume.** On an interrupt, save the `GateRequest`, notify yourself, and exit. Add a resume command:

```
flows resume <runId> --decision approve [--notes "..."]
```

It calls `graph.invoke(new Command({ resume }), { configurable: { thread_id: runId } })`.

**3. Send the notification** through whatever reaches you. Your `agent-flow` daemon already does iMessage in and out; it can become the gate front end. Map a reply like "approve T-002" to `flows resume`. ntfy.sh and Slack are simpler alternatives.

The graphs don't change at all. That's the point of the `GateRequest`/`GateDecision` types in `core/src/gates.ts`.

---

## 5. Close the loop

- **Open PRs.** In `approveMerge`, on `merge`, push the worktree branch and run `gh pr create --fill --head flows/<task>`. Leave the actual merge to you, or add `gh pr merge --squash` once you trust it.
- **Run tasks in order.** `flows tasks --done …` shows what's ready. A small loop that runs `deliver` for each ready task (in parallel, since the worktrees are isolated) turns `tasks.yaml` into a work queue.
- **Tracing.** Add `@langfuse/langchain` and pass its callback handler in the `invoke` config. You'll see each node's latency and cost. The `log[]` in state already records model and cost per node.
- **Evals before tuning prompts.** Collect 10–20 real diffs with known issues under `evals/review/`, and record which findings should appear. Re-run after every prompt or model change. This is the only reliable way to tell whether a change helped.
- **Replanning.** When `escalate` shows the task itself was wrong, write `runs/.../replan.md`. Then re-run planning from `breakdown` with that note, rather than starting over.
