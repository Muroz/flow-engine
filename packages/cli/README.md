# @flows/cli

The `flows` command. It loads `.env` from the engine root, builds the dependencies for a run, starts a flow and asks you at each gate. The first line of each run names the judge and the model backends it calls, for example `judge llm · models claude-code`.

From the engine root, run it with `pnpm flows <command>`. To run it from any folder, add an alias:

```bash
alias flows='pnpm --silent --dir /path/to/flow-engine flows'
```

The CLI resolves `--repo`, `--artifacts`, `--diff-file` and `--brief` against the folder you ran the command from. pnpm passes that folder to the CLI as `INIT_CWD`.

The [root README](../../README.md#commands) lists the commands and options.

## Answering gates

At each gate, the CLI prints a short summary and a numbered list of choices. Type a choice or its number. An empty line never counts as an answer, so a stray Enter does nothing.

- **`back`** reopens the previous gate. Everything after it runs again, so its model calls cost again. In delivery, the code the agent already wrote stays in the worktree.
- **`pause`** saves the run and exits. `flows resume <run id>` picks it up at the same gate, even after a restart.
- **`discard`, `reject` and `abort`** ask you to confirm.
- **`revise` and `adjust`** need notes and ask until you give some.
- **Every other choice** asks for optional notes. That is how notes on `retry` or `fix` reach the agent.
- **`--yes`** picks the first option at every gate, without confirming. At the escalate gate that is `abort`, so an unattended `deliver --yes` that gets stuck ends the run.

While a flow runs, the CLI prints one line per finished step, with its time, cost and a short note. Some steps add detail lines below: each check's result, the notes an attempt is addressing, or the findings a review kept. Review steps that delivery runs print indented. While the coding agent works, the CLI prints one line per tool it uses. On a terminal, a counter shows how long the current step has been running. Each gate starts with what the run has spent on model calls so far, in US dollars.

`flows review` prints the same progress lines.

`flows runs` lists paused runs. Add `--repo <dir>` to list only that project's runs.

The CLI saves every planning and delivery run to `runs/checkpoints.db`, and writes `run.json` in the run folder with what `resume` needs. Both are under `runs/`, which git ignores.

## Files

| File | What it does |
|---|---|
| `src/index.ts` | Parses arguments, loads the config, picks the flow and writes run output. |
| `src/drive.ts` | Runs a checkpointed graph to the end and prints progress. At each `interrupt()`, it shows the `GateRequest`, reads your decision and resumes the graph with `Command({ resume })`. It handles `back` by forking the run from the previous gate's checkpoint. With `--yes`, it picks the first option. |
| `src/runs.ts` | Reads and writes `run.json`, lists paused runs and opens the checkpoint database. |

`drive` is the only part that knows about the terminal. To answer gates from Slack or a phone instead, replace `drive` and leave the graphs alone. [docs/wiring.md](../../docs/wiring.md#4-persistent-runs-and-gates-away-from-the-terminal) sketches how.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The command finished. For `review`, the verdict was `pass`. `deliver` and `plan` exit 0 whatever you chose at the gates, including `reject`, `abort` and `discard`: the outcome is in the last line and in `state.json`. |
| 1 | Bad arguments, a missing task, an error, or, for `adrs`, a broken link. |
| 2 | `review` only: the verdict was `fix` or `escalate`. |

## Tests

`test/drive.test.ts` covers how the CLI reads gate answers: an empty line, choosing by number, confirmation and required notes. Run it with `pnpm test` from the engine root.
