# flow-engine

flow-engine runs software work as graphs of small steps. It uses LangGraph.js for orchestration, OpenRouter for models and Jev for judges. You approve intent (scope, architecture, risky plans) and outcomes (merges). The graph runs everything in between, puts a judge or plain code in front of every branch and logs every step.

It has three flows:

```
┌────────────────────┐   PRD, ADRs,        ┌────────────────────┐
│ planning           │── tasks.yaml ──────►│ delivery           │  one task at a time
│ rare, human-heavy  │                     │ mostly autonomous  │
└────────────────────┘                     │   ┌────────────┐   │
          ▲  replan proposals (not built)  │   │ review     │◄──┼── also standalone,
          └────────────────────────────────┤   │ (subgraph) │   │   on any diff or PR
                                           │   └────────────┘   │
                                           └────────────────────┘
```

| Flow | Input | Output | Status |
|---|---|---|---|
| [review](packages/review/README.md) | A diff, and optionally a task | A verdict (`pass`, `fix` or `escalate`) and a one-screen report | Ready for real use |
| [delivery](packages/delivery/README.md) | One task from `plan/tasks.yaml` | Code on branch `flows/<task>`, reviewed and approved by you | Ready to try with Claude Code as the agent |
| [planning](packages/planning/README.md) | A client brief | A PRD, ADRs and `plan/tasks.yaml` | Runs end to end; the prompts are first drafts |

## Requirements

- Node.js 20.12 or later. The CLI loads `.env` with `process.loadEnvFile`, which arrived in 20.12.
- pnpm 9. Run `corepack enable` if you don't have it.
- git.
- For live runs, an [OpenRouter](https://openrouter.ai) key. A [TypeSafe](https://console.typesafe.ai) key for Jev is optional.
- For delivery with a real agent, the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI, signed in, on your `PATH`.

## Quick start

Run the full offline check. It needs no keys:

```bash
bash scripts/verify.sh
```

The script installs dependencies, type-checks, runs the unit tests and runs all three sample flows against mocks. It writes everything to `runs/verify.log`. Every step ends in `exit 0` except review, which ends in `exit 2` because the sample diff is bad on purpose.

To run the steps one at a time:

```bash
pnpm install
pnpm test                  # unit tests for nodes, routing and the worktree helpers
pnpm review:sample         # review a sample diff with five specialist reviewers
pnpm deliver:sample --yes  # plan, risk, implement, checks, review loop, stop rule
pnpm plan:sample --yes     # brief, questions, scope, three architectures, ADRs, tasks
```

Without `--yes`, each human gate asks you in the terminal. The mocks are test doubles, not reviewers. They exist so you can watch every node and edge run.

## Use it on your own project

1. Copy the env file and add your OpenRouter key:

   ```bash
   cp .env.example .env
   ```

2. Add a shell alias, so you can run `flows` from any project folder:

   ```bash
   alias flows='pnpm --silent --dir /path/to/flow-engine flows'
   ```

   The CLI resolves relative paths against the folder you run it from, so `--repo .` works.

3. From your project folder, review your branch:

   ```bash
   flows review --repo . --base main --head my-branch
   ```

   The review covers commits on `my-branch` that aren't on `main`. To review work you haven't committed, write it to a diff file first. `git diff` leaves out files git doesn't track yet, so `git add -N .` marks them first:

   ```bash
   git add -N .
   git diff main > /tmp/wip.diff
   flows review --repo . --diff-file /tmp/wip.diff
   ```

`flows review` exits with code 2 when the verdict isn't `pass`, so it can gate CI. Each run writes its report to `runs/<project>/<run id>/` in this repo. That folder is git-ignored, and the flows never write run output into your project.

[docs/wiring.md](docs/wiring.md) walks through the rest in order: CI, the coding agent, gates away from the terminal and closing the loop. [docs/configuration.md](docs/configuration.md) lists every `.flows.yaml` setting.

## Commands

| Command | What it does |
|---|---|
| `flows review --repo <dir> [--base main --head HEAD \| --diff-file <f>] [--task <id>]` | Reviews a diff. With `--task`, the spec reviewer checks the diff against that task's acceptance criteria. |
| `flows deliver --repo <dir> --task <id> [--base main] [--diff-file <f>]` | Takes one task from plan to merge gate. `delivery.agent` in `.flows.yaml` picks who writes the code. |
| `flows plan --repo <dir> --brief <file> [--write]` | Turns a brief into a PRD, ADRs and tasks. Writes a proposal under `runs/` unless you pass `--write`. |
| `flows tasks --repo <dir> [--done T-001,T-002]` | Prints the task list and marks which tasks are ready to start. Needs no keys. |

Every command also takes these options:

- `--artifacts <dir>` reads `.flows.yaml`, `docs/` and `plan/` from a separate workspace. Use it for client repos that shouldn't carry your files.
- `--offline` swaps every model and judge for mocks. Setting `FLOWS_OFFLINE=1` does the same.
- `--yes` accepts the first option at every gate.

> **Warning:** `flows plan --write` writes `docs/prd.md`, `docs/adr/*.md` and `plan/tasks.yaml` straight into the artifacts folder and replaces files with the same names. Run without `--write` first and read the proposal.

## Layout

```
packages/
  core/       shared contracts, config, OpenRouter client, judges, artifact I/O, prompts, gate types
  review/     specialist reviewers, dedupe, judge triage, verdict, report
  delivery/   plan, risk, implement, checks, review subgraph, gates
  planning/   discovery, scope, architecture options, ADRs, tasks, coverage check
  cli/        the flows command and the terminal gate driver
prompts/      one markdown prompt per generative node
examples/     sample-project: config, ADR, tasks and a diff that is bad on purpose
docs/         wiring guide and configuration reference
scripts/      verify.sh
runs/         run output, git-ignored
```

Each package has its own README: [core](packages/core/README.md), [review](packages/review/README.md), [delivery](packages/delivery/README.md), [planning](packages/planning/README.md) and [cli](packages/cli/README.md). [prompts](prompts/README.md) and [the sample project](examples/sample-project/README.md) have one too.

Each flow package has the same four source files. Copy the pattern when you add a flow:

| File | What goes in it |
|---|---|
| `state.ts` | Plain TypeScript types for the state, with no framework imports. |
| `nodes.ts` | Node functions that take state and return a partial update, plus the routing functions. You can test them without building a graph. |
| `graph.ts` | The LangGraph `Annotation` (the state plus its reducers) and the wiring. The header comment holds the diagram. |
| `mocks.ts` | Offline responses, so every node and edge runs with no network. |

## How to design a flow

Every graph framework asks you to define the same five things.

1. **State.** Write the type first. Include the input, the artifacts (a path plus a short summary), loop counters, gate decisions and a log. If you can't write the state, you don't understand the flow yet.
2. **Nodes.** Give each node one of four kinds before you write it, and push as much work as you can into the first kind:
   - Deterministic: plain code such as git, tests, file I/O and policy.
   - Generative: an OpenRouter call that writes text or code.
   - Judge: a Jev call that returns a typed decision, such as yes or no, one of N or a score.
   - Human: a gate, built on `interrupt()`.
3. **Edges.** There are four kinds:
   - Static: A always leads to B.
   - Conditional: a function of state picks the next node.
   - Fan-out: `Send` starts one branch per item, and a reducer merges what they return.
   - Loop: always with a stop rule.

   Put a judge or plain policy code in front of every conditional edge.
4. **Gates.** Gate at the ends (intent and outcome), not in the middle. Let risk decide: low risk with high confidence goes ahead, and anything else waits for you. Keep every gate summary to one screen.
5. **Context.** Give each node a view of the state, not all of it. `packages/review/src/reviewers.ts` shows how. Pass large things by path, and summarise at boundaries. The model that checks the work should differ from the model that made it.

Three LangGraph rules have already caused bugs here:

- **Parallel writes need reducers.** Any field that fan-out branches write needs a `concat` reducer, as `rawFindings`, `options` and `log` have. Don't return such a field from a later node unless you mean to append to it.
- **A resumed node runs again from its first line.** After `interrupt()`, LangGraph re-runs the whole node. Keep model calls in the node before the gate, not in the gate node.
- **A node can't share a name with a state key.** LangGraph refuses to build the graph. That is why the review node that writes `report` is called `writeReport`.

## Where the tools fit

| Layer | Tool | Code |
|---|---|---|
| Generative nodes | OpenRouter. `.flows.yaml` sets a model per role, and `openrouter.provider` enforces a client's data policy. | `packages/core/src/models.ts` |
| Judge nodes | Jev asks `noul` (yes or no), `choice` and `score` questions over one piece of state, several in one call. Without a Jev key, an LLM judge with the same interface takes over. | `packages/core/src/judge.ts` |
| Coding agent | Claude Code, headless, in one git worktree per task. | `packages/delivery/src/agents/claude-code.ts` |
| Orchestration | LangGraph.js: `StateGraph`, `Send`, `interrupt` and a checkpointer. | `packages/*/src/graph.ts` |
| Knowledge | ADRs and `tasks.yaml`. | `packages/core/src/artifacts.ts` |

## Project repos and client repos

This repo is the engine. A project keeps only its artifacts:

```
some-project/
  .flows.yaml          models, reviewers, thresholds, checks, conventions
  docs/prd.md
  docs/adr/0001-*.md
  plan/tasks.yaml
```

For a client repo that shouldn't carry these files, keep them in a workspace folder you own and pass `--artifacts <dir>`. Check the client's AI policy before you send their code to any model.

## Known limits

- Gates only wait while the CLI process runs. The graphs use an in-memory checkpointer, so a run that stops at a gate can't be resumed later. [docs/wiring.md](docs/wiring.md#4-persistent-runs-and-gates-away-from-the-terminal) describes the fix.
- Approving a merge records the decision. It doesn't push the branch or open a PR.
- The Jev client follows the REST shape in TypeSafe's launch docs (`POST /v1/systemone`), and nobody has checked it against the live API yet. If calls fail, compare it with the current API reference. Only `JevJudge` needs to change.
- There is no eval set yet, so you can't yet measure whether a prompt change helped.

## Next steps

- [ ] Run `flows review` on a real branch of your own.
- [ ] Set `delivery.agent: claude-code` on a low-risk project and deliver one small task.
- [ ] Add a golden-diff eval set under `evals/` before you tune the review prompts.
- [ ] Swap `MemorySaver` for `@langchain/langgraph-checkpoint-sqlite` and add `flows resume`, so gates can wait across restarts.
- [ ] Open a PR from the merge gate.
- [ ] Add Langfuse tracing and compare judge cost between Jev and the LLM judge.
- [ ] Let delivery write a replan proposal when a task contradicts the plan, and let planning resume from `breakdown`.
