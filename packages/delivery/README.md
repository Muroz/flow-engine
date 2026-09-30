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
| `approveMerge` | Gate | Shows you the outcome. It records your decision; it doesn't push or open a PR yet. |

## Agents

`delivery.agent` in `.flows.yaml` picks who writes the code.

- **`diff-file`**, the default, replays the diff from `--diff-file` (or `git diff --base...--head`) on every attempt. The sample flow and the tests use it, and `--offline` always does.
- **`claude-code`** runs Claude Code headless in a git worktree on branch `flows/<task>`. The code is in `src/agents/claude-code.ts`, and [docs/wiring.md](../../docs/wiring.md#3-coding-agent) explains how to turn it on.

With `claude-code`, each attempt's prompt holds the task, the plan, the ADR decisions, the conventions and the notes from the last failed checks or review. The agent may use `Read`, `Edit`, `Write`, `Glob` and `Grep`, and may run exactly your check commands in Bash. A `claude-code/<model>` value in `models.implementer` picks its model. If the agent exits with an error, the flow logs it and carries on, and checks and review decide what happens next.

## Run output

Each run writes to `runs/<project>/<run id>/` in the engine:

- `state.json` holds the final state, including the log.
- `review.md` holds the last review report.
- `agent-attempt-<n>.json` holds each Claude Code transcript, or `.log` when the agent failed.

## Tests

`test/routing.test.ts` covers every conditional edge. `test/worktree.test.ts` runs the worktree helpers against a throwaway git repo. Run them with `pnpm test` from the engine root.
