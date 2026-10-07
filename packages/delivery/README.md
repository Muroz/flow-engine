# @flows/delivery

The delivery flow takes one planned task from plan to merge gate. It writes a plan, decides whether you need to see it, has an agent write the code, runs your checks and runs the review flow. It loops until the work passes or a stop rule hands it to you.

## Graph

```
START → makePlan → assessRisk ─┬─(low)──────────────► implement ◄─────────────┐
                               └─(else)─► approvePlan ─┘   │                   │
                                          (gate)           ▼                   │
                                                       runChecks ─(fail, n<max)─┤
                                                           │ pass               │
                                                           ▼                    │
                                                   runReview (subgraph) ─(fix, n<max)
                                                           │ pass
                                escalate (gate) ◄─(escalate, or n≥max)
                                    │ accept               ▼
                                    └──────────────► explainWork
                                                           ▼
                                                   approveMerge (gate) → END
```

You see the flow at most three times: the plan, only when it is risky; an escalation, only when the flow is stuck; and the merge. Each gate fits on one screen.

| Node | Kind | What it does |
|---|---|---|
| `makePlan` | Generative | Writes a short plan from the task, its acceptance criteria and its ADRs. |
| `assessRisk` | Judge | Rates the plan low, medium or high. It never rates below the risk that planning gave the task. |
| `approvePlan` | Gate | Shows you the plan when its risk is above `delivery.autoApproveRisk`. |
| `implement` | Agent | Writes the code. See [Agents](#agents). |
| `runChecks` | Deterministic | Runs `delivery.checks` in the worktree. A failure becomes a note for the next attempt. |
| `runReview` | Subgraph | Runs the review flow on the diff and the task, and maps back only the verdict, findings and report. |
| `escalate` | Gate | Hit when attempts reach `delivery.maxAttempts` or review escalates. You can abort, retry with a fresh attempt count or accept the work as it is. |
| `explainWork` | Generative | Writes `walkthrough.md`, a plain-language account of the work. See [Walkthroughs](#walkthroughs). |
| `approveMerge` | Gate | Shows you the walkthrough's summary, the checks and the review, and links to the full walkthrough. It records your decision; it doesn't push or open a PR yet. On `merge`, it adds the task to the project journal. |

## Agents

`delivery.agent` in `.flows.yaml` picks who writes the code.

- **`diff-file`**, the default, replays the diff from `--diff-file` (or `git diff --base...--head`) on every attempt. The sample flow and the tests use it, and `--offline` always does.
- **`claude-code`** runs Claude Code headless in a git worktree on branch `flows/<task>`. The code is in `src/agents/claude-code.ts`, and [docs/wiring.md](../../docs/wiring.md#3-coding-agent) explains how to turn it on.

With `claude-code`, each attempt's prompt holds the task, the plan, the ADR decisions, the conventions and the notes from the last failed checks or review. The agent may use `Read`, `Edit`, `Write`, `Glob` and `Grep`, and may run exactly your check commands in Bash. A `claude-code/<model>` value in `models.implementer` picks its model. If the agent exits with an error, the flow logs it and carries on, and checks and review decide what happens next.

## Walkthroughs

Before the merge gate, `explainWork` explains the work for someone who hasn't read the code. It uses the `planner` model and the prompt in `prompts/delivery/walkthrough.md`. Each walkthrough has five sections:

1. **In short:** what you can do now that you couldn't before.
2. **How it works:** the steps in order, with every term explained. When parts talk to each other, it adds a diagram written in [Mermaid](https://mermaid.js.org), a text format that GitHub and most Markdown viewers draw as a picture.
3. **What changed:** a table of files and their jobs.
4. **How to try it:** steps you can follow to see it working.
5. **Worth knowing:** shortcuts, limits, unfixed review findings and follow-up work.

Walkthroughs help you follow the work. They are not project documentation, so they stay under `runs/` and never go into the project repo.

On `merge`, the flow adds the walkthrough's summary and a link to `runs/<project>/journal.md`. Read that one file to follow the whole project, task by task. Offline runs skip the journal.

To write a walkthrough outside a delivery run, for example for work you merged earlier, use `flows explain`:

```bash
pnpm flows explain --repo /path/to/project --task T-003
```

It explains the changes in the task's worktree when one exists. Otherwise it explains the diff you give it with `--diff-file`, or the commits on `--head` that aren't on `--base`, which default to `HEAD` and `main`. It also reuses the plan and review from the task's latest delivery run that used real models, skipping `--offline` runs.

## Writing rules

`prompts/_writing.md` holds the writing rules: Orwell's six rules and the main points of Google's developer documentation style guide. Three places use them:

- **`explainWork` and `flows explain`:** every walkthrough follows them.
- **The Claude Code agent:** its prompt tells it to follow them in any docs or comments it writes, and to leave out comments that restate the code.
- **The `docs` reviewer:** it checks docs and comments in each diff against them. See [the review flow](../review/README.md#specialists).

## Run output

Each run writes to `runs/<project>/<run id>/` in the engine:

- `state.json` holds the final state, including the log.
- `review.md` holds the last review report.
- `agent-attempt-<n>.json` holds each Claude Code transcript, or `.log` when the agent failed.
- `walkthrough.md` holds the plain-language walkthrough.

`runs/<project>/journal.md` lists every merged task.

## Tests

`test/routing.test.ts` covers every conditional edge. `test/worktree.test.ts` runs the worktree helpers against a throwaway git repo. `test/walkthrough.test.ts` covers how the gate picks the walkthrough's summary. Run them with `pnpm test` from the engine root.
