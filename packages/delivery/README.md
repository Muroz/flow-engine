# @flows/delivery

The delivery flow takes one planned task from plan to merge gate. It writes a plan, decides whether you need to see it, has an agent write the code, runs your checks and runs the review flow. It loops until the work passes or a stop rule hands it to you.

## Graph

```
START → makePlan ◄──(revise)──────────────── approvePlan (gate)
           ▼                                    ▲      │ approve
        assessRisk ─(above autoApproveRisk)─────┘      ▼
           └─(otherwise)──────────────────────────► implement ◄───────────────────────────┐
                                                       ▼ (no changes: escalate)           │
                                                   runChecks ─(fail, attempts left)───────┤
                                                       ▼ pass                             │
                                               runReview (subgraph) ─(fix, attempts left)─┤
                                                       │ pass                             │
         escalate (gate) ◄─(escalate, out of attempts or over budget)                     │
           │ retry ───────────────────────────────────────────────────────────────────────┤
           │ accept                                    ▼                                  │
           └─────────────────────────────────► explainWork                                │
                                                       ▼                                  │
                                              approveMerge (gate) ─(fix)──────────────────┘
                                                       ▼ merge or reject
                                                      END
```

The flow has three gates: the plan, only when it is risky; an escalation, only when the flow is stuck; and the merge. `revise`, `retry` and `fix` can bring you back to a gate. Each gate fits on one screen and links to a file with the full text.

| Node | Kind | What it does |
|---|---|---|
| `makePlan` | Generative | Writes a short plan from the task, its acceptance criteria and its ADRs. After a `revise`, it rewrites the plan from your notes. |
| `assessRisk` | Judge | Rates the plan low, medium or high. It never rates below the risk that planning gave the task. |
| `approvePlan` | Gate | Shows you the numbered steps and the acceptance criteria when the risk is above `delivery.autoApproveRisk`. Options: `approve`, `revise` with notes, or `reject`. |
| `implement` | Agent | Writes the code. See [Agents](#agents). When the agent changes nothing, the flow skips checks and review and goes to the escalate gate. Offline runs skip that test, since the mock agent replays a fixed diff. |
| `runChecks` | Deterministic | Runs `delivery.checks` in the worktree, in order, and records each command's result and time. It stops at the first failure, and the failure's output becomes a note for the next attempt. |
| `runReview` | Subgraph | Runs the review flow on the diff and the task, and maps back only the verdict, findings and report. Each finding becomes a note for the next attempt, with the reviewer's reason. |
| `escalate` | Gate | See [When the flow gets stuck](#when-the-flow-gets-stuck). |
| `explainWork` | Generative | Writes `walkthrough.md`, a plain-language account of the work. See [Walkthroughs](#walkthroughs). |
| `approveMerge` | Gate | Shows the walkthrough's summary, each check's result, the review verdict and the open review comments, numbered. Options: `merge`, `fix` or `reject`. `merge` commits the worktree on `flows/<task>` and fast-forwards the base to it. See [Fixing comments before you merge](#fixing-comments-before-you-merge). |

## Routing

Plain code at the end of `src/nodes.ts` picks every branch. "Attempts left" means `attempts` is below `delivery.maxAttempts`. "Under budget" means the spend since the last `retry` or `fix` is below `delivery.maxCostUsd`, or the limit is 0. Each edge that isn't listed here is static.

| After | Condition | Goes to | Function |
|---|---|---|---|
| `assessRisk` | The plan's risk is at or below `delivery.autoApproveRisk`. The scale runs `none`, `low`, `medium`, `high`, and the judge never rates `none`, so `autoApproveRisk: none` shows you every plan | `implement` | `afterRisk` |
| `assessRisk` | Otherwise | `approvePlan` | `afterRisk` |
| `approvePlan` | `approve` | `implement` | `afterPlanGate` |
| `approvePlan` | `revise` | `makePlan` | `afterPlanGate` |
| `approvePlan` | `reject` | END | `afterPlanGate` |
| `implement` | The diff is empty, in an online run | `escalate` | `afterImplement` |
| `implement` | Otherwise | `runChecks` | `afterImplement` |
| `runChecks` | Every check passed | `runReview` | `afterChecks` |
| `runChecks` | A check failed, with attempts left and under budget | `implement` | `afterChecks` |
| `runChecks` | A check failed, otherwise | `escalate` | `afterChecks` |
| `runReview` | `pass` | `explainWork` | `afterReview` |
| `runReview` | `fix`, with attempts left and under budget | `implement` | `afterReview` |
| `runReview` | `escalate`, or `fix` out of attempts or over budget | `escalate` | `afterReview` |
| `escalate` | `retry` | `implement` | `afterEscalate` |
| `escalate` | `accept` | `explainWork` | `afterEscalate` |
| `escalate` | `abort` | END | `afterEscalate` |
| `approveMerge` | `fix` | `implement` | `afterMerge` |
| `approveMerge` | `merge` or `reject` | END | `afterMerge` |

## Rounds and what you see

A round is one pass through `implement`, `runChecks` and `runReview`. While a round runs, the CLI prints each step as it finishes:

- **implement:** the round and attempt number, such as `round 2, attempt 2/3`, then one line per note the agent is addressing. While the agent works, one line per tool it uses, such as `Edit src/app/page.tsx` or `Bash pnpm test`.
- **checks:** one line per command, such as `✓ pnpm lint (4.1s)`, `✗ pnpm test (3.2s)` or `· pnpm build (not run)`.
- **review:** each specialist's result and cost, then the findings it kept.

`delivery.maxAttempts`, 3 by default, limits the rounds before the flow asks you. A `retry` or `fix` grants `delivery.retryAttempts` more, 1 by default.

## Cost

Each review round calls six specialists, so the review is most of a run's model cost. Three settings keep it down:

- **Generated files stay out.** Review and walkthroughs skip lockfiles, build output, source maps and snapshots. `DEFAULT_REVIEW_IGNORE` in `packages/core/src/config.ts` lists them, and `review.ignore` adds your own patterns. The review's first progress line names the files it skipped.
- **The docs reviewer reads less.** It sees doc files in full, but only the code hunks that add a comment.
- **A cost limit stops the loop.** When a run's model spend reaches `delivery.maxCostUsd`, $5 by default, the flow stops and asks you. A `retry` or `fix` starts the count again.

The Claude Code agent runs on your Claude plan. Its transcript reports a list price, which the implement line shows, but the run's model cost leaves it out.

## When the flow gets stuck

The escalate gate opens when the agent changes nothing, the flow runs out of attempts, it hits the cost limit, or a reviewer wants a person to look. It shows:

- why it stopped, including the spend when it hit the cost limit, or the agent's last message when it changed nothing
- one line per review round so far, such as `round 2: fix: 2 major/blocker finding(s)`
- the last check failure, if checks failed
- every open finding, blocking ones first, each with its file, line and the reviewer's reason

The full review report for the last round is linked from the gate. Options:

- **`retry`** grants `delivery.retryAttempts` more attempts and starts the cost count again. Notes you add go to the agent.
- **`accept`** takes the work as it is and moves on to the walkthrough and the merge gate. The gate leaves it out when the agent changed nothing.
- **`abort`** ends the run, after you confirm.

## Fixing comments before you merge

When the review passes with minor comments, or you accept work with open findings, the merge gate numbers them. `fix` sends them back for `delivery.retryAttempts` more attempts, then the work goes through checks, review and the walkthrough again before you see the merge gate.

Your notes pick what goes back:

- No notes: every open comment.
- Numbers, such as `1,3`: those comments. Add text after a colon, such as `1,3: also rename the helper`, to send it too.
- Text alone: only your text.

## Agents

`delivery.agent` in `.flows.yaml` picks who writes the code.

- **`diff-file`**, the default, replays the diff from `--diff-file` (or `git diff --base...--head`) on every attempt. The sample flow and the tests use it, and `--offline` always does.
- **`claude-code`** runs Claude Code headless in a git worktree on branch `flows/<task>`. The code is in `src/agents/claude-code.ts`, and [docs/wiring.md](../../docs/wiring.md#3-coding-agent) explains how to turn it on.

With `claude-code`, each attempt's prompt holds the task, the plan, the ADR decisions, the conventions and the notes from the last failed checks or review. The prompt also lists the project's `standards` files and tells the agent to read them first. In a follow-up round, it tells the agent to fix only those notes and leave the rest alone. `agentPrompt` in `src/nodes.ts` builds the prompt.

Files git doesn't track, such as `.env`, don't reach a new worktree. List them under `delivery.copyToWorktree`, and delivery copies them in so the checks can use them. The agent may use `Read`, `Edit`, `Write`, `Glob` and `Grep`, and may run exactly your check commands in Bash. A `claude-code/<model>` value in `models.implementer` picks its model. Otherwise it uses `claudeCode.model`, which defaults to `opus`. If the agent exits with an error, the flow logs it and carries on, and checks and review decide what happens next.

## Walkthroughs

Before the merge gate, `explainWork` explains the work for someone who hasn't read the code. It uses the `planner` model and the prompt in `prompts/delivery/walkthrough.md`. Each walkthrough has five sections:

1. **In short:** what you can do now that you couldn't before.
2. **How it works:** the steps in order, with every term explained. When parts talk to each other, it adds a diagram written in [Mermaid](https://mermaid.js.org), a text format that GitHub and most Markdown viewers draw as a picture.
3. **What changed:** a table of files and their jobs.
4. **How to try it:** steps you can follow to see it working.
5. **Worth knowing:** shortcuts, limits, unfixed review findings and follow-up work.

The merge gate shows the "In short" and "How it works" sections, with each diagram replaced by a pointer to the full text in `walkthrough.md`.

Walkthroughs help you follow the work. They are not project documentation, so they stay under `runs/` and never go into the project repo.

On `merge`, once the base holds the work, the flow adds the walkthrough's summary and a link to `runs/<project>/journal.md`. Read that one file to follow the whole project, task by task. Offline runs skip the journal.

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
- `review-<round>.md` holds each round's review report.
- `agent-<round>.json` holds Claude Code's final result for each round, and `agent-<round>.jsonl` every event it streamed. A failed agent run writes `agent-<round>.log` instead.
- `review.md` holds the last review report.
- `walkthrough.md` holds the plain-language walkthrough.

`runs/<project>/journal.md` lists every merged task.

## Tests

`test/routing.test.ts` covers every conditional edge, the cost limit and how `fix` picks comments. `test/worktree.test.ts` runs the worktree helpers against a throwaway git repo and covers how agent steps print. `test/walkthrough.test.ts` covers how the gate picks the walkthrough's summary. Run them with `pnpm test` from the engine root.
