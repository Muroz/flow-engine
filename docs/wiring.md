# Wiring it up

Work through these stages in order. Each one works on its own, so you can stop at any stage and still have something useful.

| Stage | You get | Effort |
|---|---|---|
| 0. Verify | Proof that the engine runs on your machine | 5 minutes |
| 1. Keys and a real review | AI code review on any branch, yours or a client's | 30 minutes |
| 2. Review in CI | A review on every PR, posted as a comment | 1 hour |
| 3. Coding agent | Delivery writes code in a worktree per task | 30 minutes |
| 4. Persistent runs and remote gates | Runs that survive restarts, and approvals from your phone | Half a day, not built yet |
| 5. Close the loop | PRs, a work queue, tracing and evals | Ongoing, not built yet |

## 0. Verify

From the engine folder, run:

```bash
bash scripts/verify.sh
```

The script installs dependencies, type-checks, runs the unit tests and all three sample flows offline, then writes `runs/verify.log`. A good run looks like this:

- Every step shows `exit 0`, except review, which shows `exit 2` because the sample diff is bad on purpose.
- Deliver ends with `outcome: escalated after 3 attempt(s)`.
- Plan ends with `planning emitted` and lists four files.

## 1. Keys and a real review

1. Copy the env file:

   ```bash
   cp .env.example .env
   ```

2. Add your keys to `.env`:
   - `OPENROUTER_API_KEY`, which every live run needs.
   - `TYPESAFE_API_KEY` for Jev, which is optional. Without it, the judges fall back to an LLM judge through OpenRouter, which is slower and costs more. Jev calls go straight to TypeSafe, not through OpenRouter; [Client repos](#client-repos) explains what that means for client code.
3. Check the model slugs in your project's `.flows.yaml` against [openrouter.ai/models](https://openrouter.ai/models). Keep `reviewer` on a different vendor from `default` and `implementer`.
4. Run the live smoke test. It reviews the sample diff with real models, which costs a few cents:

   ```bash
   bash scripts/verify.sh --live
   ```

5. Review a real branch of your own:

   ```bash
   pnpm flows review --repo /path/to/project --base main --head my-branch
   ```

   To run `flows` from inside the project folder instead, add the alias from [Use it on your own project](../README.md#use-it-on-your-own-project).

A project without `.flows.yaml` gets the defaults: no ADRs, no conventions and no spec reviewer, which only runs when you pass `--task`. For more useful reviews, add a `.flows.yaml`, a few ADRs under `docs/adr/` and your conventions. The architecture reviewer then has something to check against. [configuration.md](configuration.md) lists every setting.

### Client repos

A client repo keeps its code in its own checkout. Everything the flows need lives in a workspace folder you own:

```
/path/to/workspaces/<client>/
  .flows.yaml        models, and openrouter.provider set to the client's AI policy
  docs/adr/
  plan/tasks.yaml
```

Point the review at both:

```bash
pnpm flows review --repo /path/to/client-repo --artifacts /path/to/workspaces/<client> --base main --head feature-x
```

Before you send a client's code anywhere, confirm their AI policy. Then restrict providers in that workspace's config:

```yaml
openrouter:
  provider:
    data_collection: deny
    only: [anthropic]  # whichever providers the client allows
```

Jev calls go straight to TypeSafe and skip this allow-list. Setting `only` keeps them off: under `judge.engine: auto`, a project with an allow-list uses the LLM judge through OpenRouter, even when `TYPESAFE_API_KEY` is set. If the client approves TypeSafe, add this to the workspace config:

```yaml
judge:
  engine: jev
```

Each run's first line names the judge it uses, for example `judge llm`. Check it before the first run on a client repo.

### Tuning the judge

These settings live under `review:` in `.flows.yaml`:

- **`minConfidence`**, default 0.6: raise it if reviews are noisy, and lower it if they miss things.
- **`dropSeverities`**: add `minor` if you only want blocking issues.
- **`escalateAtSeverity`**: set it to `major` and the flow asks you more often.

After a few real runs, compare the `review.triage` lines in the report's provenance section between Jev and the LLM judge. That comparison shows what Jev saves in time and cost.

## 2. Review on every PR

Add this workflow to the project repo as `.github/workflows/flows-review.yml`. It checks out the engine next to the project, reviews the PR and posts the report as a comment:

```yaml
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/checkout@v4
        with: { repository: <you>/flow-engine, path: .flow-engine, token: "${{ secrets.FLOW_ENGINE_TOKEN }}" }
      - uses: pnpm/action-setup@v4
        with: { package_json_file: .flow-engine/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd .flow-engine && pnpm install --frozen-lockfile
      - run: |
          set -o pipefail
          cd .flow-engine
          pnpm flows review --repo "$GITHUB_WORKSPACE" \
            --base "origin/${{ github.base_ref }}" --head HEAD | tee ../review.txt
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
      - if: always()
        run: gh pr comment ${{ github.event.number }} --body-file review.txt
        env: { GH_TOKEN: "${{ github.token }}" }
```

`flows review` exits with code 2 when the verdict isn't `pass`. `set -o pipefail` passes that code through `tee`, so the job fails on blocking findings. Without it, the step would take `tee`'s exit code and always pass.

`FLOW_ENGINE_TOKEN` is a token that can read your flow-engine repo. For client repos, run the review from your own machine or CI instead of theirs. That keeps your engine private.

## 3. Coding agent

Delivery ships with two agents. `diff-file` replays a fixed diff, for demos and tests. `claude-code` runs [Claude Code](https://code.claude.com/docs) headless and writes real code. For each attempt, the `claude-code` agent does these things:

1. Creates or reuses a git worktree on branch `flows/<task>`, under `runs/<project>/worktrees/<task>/` in the engine. Your main checkout never changes.
2. Runs `claude -p` in the worktree with the task, the plan, the ADR decisions, your conventions and the notes from the last failed attempt.
3. Saves the agent's transcript as `agent-attempt-<n>.json` in the run folder.
4. Stages everything in the worktree and diffs it against `--base`. Checks and review work on that diff.

To turn it on:

1. Install Claude Code and sign in, so `claude` runs from your shell.
2. Make sure `--repo` points at the root of a git repository. The agent refuses a subfolder, so it never branches the wrong repo.
3. Set the agent and your checks in the project's `.flows.yaml`:

   ```yaml
   delivery:
     agent: claude-code
     checks:
       - pnpm test
       - pnpm lint
   ```

   The agent may run exactly these check commands and nothing else in Bash. To widen that, set `delivery.agentTools` in Claude Code's `--allowedTools` syntax.

4. Deliver a small, low-risk task:

   ```bash
   pnpm flows deliver --repo /path/to/project --task T-001 --base main
   ```

When the run ends, the CLI prints the worktree path. The changes stay there, staged but not committed, until you act on them.

Delivery reuses a task's worktree on every run, so a second run builds on the first run's changes. To start a task from scratch, remove its worktree and branch:

```bash
git -C /path/to/project worktree remove --force /path/to/flow-engine/runs/<project>/worktrees/T-001
git -C /path/to/project branch -D flows/T-001
```

> **Warning:** Both commands throw away the agent's work on that task. Commit or copy anything you want to keep first.

To use a different agent, replace `runClaudeCode` in `packages/delivery/src/agents/claude-code.ts`. Any headless agent that edits files in a folder fits.

## 4. Persistent runs and gates away from the terminal

This stage isn't built yet. Today a gate blocks the CLI process, because the graphs use `MemorySaver` and the terminal driver reads your answer with readline. To approve from your phone, you would need three changes:

1. **Persist checkpoints.** Add the SQLite checkpointer to each flow that has gates:

   ```bash
   pnpm --filter @flows/delivery --filter @flows/planning add @langchain/langgraph-checkpoint-sqlite
   ```

   Then compile the graphs with it:

   ```ts
   import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
   .compile({ checkpointer: SqliteSaver.fromConnString(join(ENGINE_ROOT, "runs", "checkpoints.db")) })
   ```

2. **Split `drive` into start and resume.** At a gate, save the `GateRequest`, notify yourself and exit. Add a resume command:

   ```
   flows resume <run id> --decision approve [--notes "..."]
   ```

   It calls `graph.invoke(new Command({ resume }), { configurable: { thread_id: runId } })`.

3. **Send the notification** through whatever reaches you: ntfy.sh, Slack or a chat bot you already run. Map a reply such as "approve T-002" to `flows resume`.

The graphs themselves don't change. That is the point of the `GateRequest` and `GateDecision` types in `packages/core/src/gates.ts`.

## 5. Close the loop

None of this is built yet.

- **Open PRs.** In `approveMerge`, on `merge`, commit in the worktree, push branch `flows/<task>` and run `gh pr create --fill --head flows/<task>`. Leave the merge itself to you, or add `gh pr merge --squash` once you trust the flow.
- **Run tasks in order.** `flows tasks --done T-001,T-002` shows what's ready. A small loop that runs `deliver` for each ready task turns `tasks.yaml` into a work queue. The worktrees are isolated, so tasks can run in parallel.
- **Tracing.** Add `@langfuse/langchain` and pass its callback handler in the `invoke` config to see each node's latency and cost. The `log` in state already records the model and cost for each node.
- **Evals before prompt tuning.** Collect 10 to 20 real diffs with known issues under `evals/review/`, and record which findings should appear. Re-run them after every prompt or model change. Without them, you can't tell whether a change helped.
- **Replanning.** When `escalate` shows that the task itself was wrong, write `runs/<project>/<run id>/replan.md`. Then re-run planning from `breakdown` with that note instead of starting over.
