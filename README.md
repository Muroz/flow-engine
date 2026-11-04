# flow-engine

flow-engine uses AI models to plan, build and review software, and stops for your approval at the points that matter. It turns a client brief into requirements, an architecture and a task list. It has a coding agent build each task in its own git branch, runs your tests, and reviews every change with several AI reviewers before you decide to merge it. You can also use the review on its own, on any branch or pull request.

Each piece of work runs as a graph of small steps. Plain code makes every decision it can, a judge model answers the small yes-or-no questions it can't, and you approve the scope, the architecture, risky plans and every merge. Every step is logged with its model and cost.

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

| Flow | What it does | You give it | You get | Status |
|---|---|---|---|---|
| [planning](packages/planning/README.md#how-a-plan-comes-together) | Asks about gaps in the brief, writes requirements, proposes three architectures and splits the work into tasks | A client brief | A PRD, ADRs and `plan/tasks.yaml` | Runs end to end; the prompts are first drafts |
| [delivery](packages/delivery/README.md#how-a-task-moves-through-it) | Plans one task, has an agent write the code, runs your checks and the review, and loops until it passes or needs you | One task from `plan/tasks.yaml` | Code on branch `flows/<task>`, reviewed and approved by you, with a plain-language walkthrough | Ready to try with Claude Code as the agent |
| [review](packages/review/README.md#how-a-review-works) | Has up to six specialist reviewers read a change, checks each finding and decides whether it passes | A diff, and optionally a task | A verdict (`pass`, `fix` or `escalate`) and a one-screen report | Ready for real use |

Most people start with review: point `flows review` at a branch you already have, as [Use it on your own project](#use-it-on-your-own-project) shows. When you start a project from a brief, run `flows plan` once, then `flows deliver` its tasks one at a time. Delivery runs the review on every attempt, so you don't run it separately there.

## Words used here

- **Gate:** a point where the flow stops and asks you to choose, such as `approve`, `revise` or `merge`. Each gate fits on one screen and links to a file with the full text.
- **Judge:** a model that answers short typed questions, such as yes or no, or one of a few levels, so plain code can act on the answer. [Jev](https://console.typesafe.ai) answers them when you have a TypeSafe key and the project doesn't restrict its providers; otherwise an ordinary model does.
- **PRD:** product requirements document, the list of what to build.
- **ADR:** architecture decision record, a short file that records one technical decision, why it was made and what it costs. Delivery and review check the code against them.
- **Task:** one unit of work in `plan/tasks.yaml`, with acceptance criteria, dependencies and a risk.
- **Finding:** one problem a reviewer reports, with where it is, how severe it is and why.
- **Verdict:** the review's answer: `pass`, `fix` (send it back to the agent) or `escalate` (a person must decide).
- **Worktree:** a second checkout of your repo in its own folder, on its own branch, so the agent never touches your working copy.
- **Run:** one execution of a flow. Its output goes to `runs/<project>/<run id>/` in this repo.

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

Without `--yes`, each human gate asks you in the terminal. Every gate also offers `back`, to reopen the previous gate, and `pause`, to save the run and finish it later with `flows resume`. The mocks are test doubles, not reviewers. They exist so you can watch every node and edge run.

## Use it on your own project

1. Copy the env file and add your OpenRouter key:

   ```bash
   cp .env.example .env
   ```

   To try it without an OpenRouter key, skip this step and add `--claude-code` to the commands below. Every model call then runs on your local Claude Code.

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

Once reviews work for you, try delivery: set `delivery.agent: claude-code` in a low-risk project's `.flows.yaml` and deliver one small task. [Coding agent](docs/wiring.md#3-coding-agent) explains the setup.

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
