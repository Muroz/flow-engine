# flow-engine

flow-engine plans, builds and reviews software with AI models. Planning turns a client brief into requirements, architecture decisions and a task list. Delivery has a coding agent implement one task at a time on its own git branch, runs your checks and reviews the change before you merge it. Review runs up to six specialist reviewers over a diff and returns a verdict, either inside delivery or on its own against any branch or pull request.

Each flow is a LangGraph graph of small nodes. Code makes every decision it can, a judge model answers the typed questions code can't, and you decide at the gates: scope, architecture, plans for risky tasks and every merge. The log records each node with its model and cost.

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

| Flow | What it does | Input | Output | Status |
|---|---|---|---|---|
| [planning](packages/planning/README.md#how-a-plan-comes-together) | Asks about gaps in the brief, writes requirements, proposes three architectures and splits the work into tasks | A client brief | A PRD, ADRs and `plan/tasks.yaml` | Runs end to end; the prompts are first drafts |
| [delivery](packages/delivery/README.md#how-a-task-moves-through-it) | Plans one task, has an agent write the code, runs your checks and the review, and loops until it passes or needs you | One task from `plan/tasks.yaml` | Code on branch `flows/<task>`, approved by you, with a walkthrough of the change | Ready to try with Claude Code as the agent |
| [review](packages/review/README.md#how-a-review-works) | Has specialist reviewers read a change, verifies each finding and decides whether the change passes | A diff, and optionally a task | A verdict and a one-screen report | Ready for real use |

Get started by pointing `flows review` at a branch you already have; [Use it on your own project](#use-it-on-your-own-project) covers the setup. To build a project from a brief, run `flows plan` once, then `flows deliver` for each task. Delivery reviews every attempt itself.

## Lexicon

- **ADR:** architecture decision record. One file under `docs/adr/` that states a technical decision, its reasons and its costs. Delivery and review check code against the ADRs.
- **Finding:** a problem a reviewer reports, with a location, a severity and a rationale. Verification can rule a finding out. For the rest, the judge names the kind of problem, and the project's triage table sets the severity before the verdict.
- **Gate:** a node that pauses the graph for a human decision, such as `approve`, `revise` or `merge`. It fits on one screen and links to the full text.
- **Judge:** a model limited to typed answers (a probability, one option from a fixed set or a level on a scale) so code can branch on the result. [Jev](https://console.typesafe.ai) serves as judge when you have a TypeSafe key and the project doesn't restrict its providers; otherwise an ordinary LLM does.
- **Node:** one step in a flow's graph: either plain code or a single model call.
- **PRD:** product requirements document, `docs/prd.md`.
- **Run:** one execution of a flow. Its log, report and other output go to `runs/<project>/<run id>/` in this repo.
- **Task:** an entry in `plan/tasks.yaml` with acceptance criteria, dependencies and a risk level.
- **Verdict:** the result of a review: `pass`, `fix` (return the change to the coding agent) or `escalate` (hand the decision to you).
- **Worktree:** the git worktree delivery creates for each task on branch `flows/<task>`, so the agent never touches your checkout.

## Requirements

- Node.js 20.12 or later. The CLI loads `.env` with `process.loadEnvFile`, which arrived in 20.12.
- pnpm 9. Run `corepack enable` if you don't have it.
- git.
- For live runs, an [OpenRouter](https://openrouter.ai) key, the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI signed in on your `PATH`, or both. [Model backends](#model-backends) explains how to choose. The Claude Code CLI is also the coding agent, so delivery with a real agent needs it. A [TypeSafe](https://console.typesafe.ai) key for Jev is optional.

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
pnpm review:sample         # review a sample diff with the specialist reviewers
pnpm deliver:sample --yes  # plan, risk, implement, checks, review loop, stop rule
pnpm plan:sample --yes     # brief, questions, scope, three architectures, ADRs, tasks
```

Without `--yes`, each human gate asks you in the terminal. Every gate also offers `back`, to reopen the previous gate, and `pause`, to save the run and finish it later with `flows resume`. The mocks are test doubles, not reviewers. They let you exercise every node and edge without a model or a key.

## Use it on your own project

1. Copy the env file and add your OpenRouter key:

   ```bash
   cp .env.example .env
   ```

   To try it without an OpenRouter key, skip this step and add `--claude-code` to the commands below. Every model call then runs on your local Claude Code.

2. Add a shell alias, so you can run `flows` from any project folder:

   ```bash
   alias flows='/path/to/flow-engine/bin/flows'
   ```

   The CLI resolves relative paths against the folder you run it from, so `--repo .` works. `bin/flows` runs the CLI directly rather than through `pnpm --silent`, which would turn review's exit code 2 into 1.

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

To try delivery, set `delivery.agent: claude-code` in a low-risk project's `.flows.yaml` and deliver one small task. [Coding agent](docs/wiring.md#3-coding-agent) explains the setup.

[docs/wiring.md](docs/wiring.md) walks through the rest in order: CI, the coding agent, gates away from the terminal and closing the loop. [docs/configuration.md](docs/configuration.md) lists every `.flows.yaml` setting.

## Commands

| Command | What it does |
|---|---|
| `flows review --repo <dir> [--base main --head HEAD \| --diff-file <f>] [--task <id>]` | Reviews a diff. With `--task`, the spec reviewer checks the diff against that task's acceptance criteria. |
| `flows deliver --repo <dir> --task <id> [--base main] [--diff-file <f>]` | Takes one task from plan to merge gate. `delivery.agent` in `.flows.yaml` picks who writes the code. |
| `flows plan --repo <dir> --brief <file> [--write]` | Turns a brief into a PRD, ADRs and tasks. Writes a proposal under `runs/` unless you pass `--write`. |
| `flows tasks --repo <dir> [--done T-001,T-002]` | Prints the task list and marks which tasks are ready to start. Needs no keys. |
| `flows adrs --repo <dir>` | Lists the ADRs with their status and relations, and exits with code 1 if a link is broken. Needs no keys. |
| `flows runs [--repo <dir>]` | Lists paused runs. |
| `flows resume <run id>` | Picks a paused run up at the gate where you paused it. |
| `flows explain --repo <dir> --task <id> [--base main] [--diff-file <f>]` | Writes a plain-language walkthrough of a task's changes. Delivery writes one before every merge gate; use this for work you want explained again. |

Every command also takes these options:

- `--artifacts <dir>` reads `.flows.yaml`, `docs/` and `plan/` from a separate workspace. Use it for client repos that shouldn't carry your files.
- `--offline` swaps every model and judge for mocks. Setting `FLOWS_OFFLINE=1` does the same.
- `--claude-code` runs every model role on your local Claude Code, so the run needs no OpenRouter key. Setting `FLOWS_CLAUDE_CODE=1` does the same.
- `--yes` accepts the first option at every gate.

> **Warning:** `flows plan --write` writes `docs/prd.md`, `docs/adr/*.md` and `plan/tasks.yaml` straight into the artifacts folder and replaces files with the same names. Run without `--write` first and read the proposal.

## Model backends

Each model role (`planner`, `reviewer`, `verifier`, `judge` and `implementer`) picks its backend by its model ID in `.flows.yaml`:

- An OpenRouter slug, such as `openai/gpt-5.5`, goes through OpenRouter with `OPENROUTER_API_KEY`.
- `claude-code/<model>`, such as `claude-code/opus`, runs the `claude` CLI on your machine with its own sign-in. `claude-code/default` lets Claude Code pick the model.

You can mix them. This config keeps the reviewer on another vendor through OpenRouter and runs everything else locally:

```yaml
models:
  default: claude-code/sonnet
  implementer: claude-code/opus
  reviewer: openai/gpt-5.5
  judge: claude-code/haiku
```

The run asks for `OPENROUTER_API_KEY` only when at least one role uses OpenRouter. The first line of each run names the judge and the backends, for example `judge llm · models openrouter+claude-code`.

OpenRouter gives you models from every vendor with one key, which matters because the reviewer should differ from the implementer. It also applies `openrouter.provider` to every call. Claude Code costs nothing beyond your Claude plan and needs no key, but every role on it runs on Anthropic models. It is also slower: each call starts a new `claude` process, about two seconds before the model starts. Jev is separate from both and always calls TypeSafe directly.

[docs/configuration.md](docs/configuration.md#models) covers the details.

## Layout

```
packages/
  core/       shared contracts, config, OpenRouter client, judges, artifact I/O, prompts, gate types
  review/     specialist reviewers, dedupe, verification, judge triage, verdict, report
  delivery/   plan, risk, implement, checks, review subgraph, gates
  planning/   discovery, scope, architecture options, ADRs, tasks, coverage check
  cli/        the flows command and the terminal gate driver
prompts/      one markdown prompt per generative node
examples/     sample-project: config, ADR, tasks and a diff that is bad on purpose
docs/         wiring guide, configuration reference and flow design guide
scripts/      verify.sh
bin/          flows, the wrapper the shell alias points at
runs/         run output, git-ignored
```

Each package has its own README: [core](packages/core/README.md), [review](packages/review/README.md), [delivery](packages/delivery/README.md), [planning](packages/planning/README.md) and [cli](packages/cli/README.md). [prompts](prompts/README.md) and [the sample project](examples/sample-project/README.md) have one too.

To add a flow or change how one works, read [Designing flows](docs/designing-flows.md) first.

## Project repos and client repos

This repo is the engine. A project keeps only its artifacts:

```
some-project/
  .flows.yaml          models, reviewers, thresholds, checks, conventions
  docs/prd.md
  docs/adr/0001-*.md
  plan/tasks.yaml
```

For a client repo that shouldn't carry these files, keep them in a workspace folder you own and pass `--artifacts <dir>`. Check the client's AI policy before you send their code to any model, and write it into `openrouter.provider.only`. That list also keeps Jev off the project unless you turn it on; see [Client repos](docs/wiring.md#client-repos).

## Known limits

- Gates are answered only in the terminal. Runs survive a restart, because the planning and delivery graphs save every step to `runs/checkpoints.db` and `flows resume` picks a paused run up, but you can't answer a gate from your phone or a chat. [docs/wiring.md](docs/wiring.md#4-persistent-runs-and-gates-away-from-the-terminal) describes what that needs.
- `merge` commits the work on `flows/<task>` and fast-forwards your local base branch to it. It doesn't push or open a PR.
- There is no eval set yet, so you can't yet measure whether a prompt change helped.

## Roadmap

- [ ] Add a golden-diff eval set under `evals/` before tuning the review prompts.
- [ ] Answer gates away from the terminal: a `flows resume --decision` command and a notification when a run pauses.
- [ ] Open a PR from the merge gate.
- [ ] Add Langfuse tracing and compare judge cost between Jev and the LLM judge.
- [ ] Let delivery write a replan proposal when a task contradicts the plan, and let planning resume from `breakdown`.
