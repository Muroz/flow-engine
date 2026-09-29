# @flows/cli

The `flows` command. It loads `.env` from the engine root, builds the dependencies for a run, starts a flow and asks you at each gate.

From the engine root, run it with `pnpm flows <command>`. To run it from any folder, add an alias:

```bash
alias flows='pnpm --silent --dir /path/to/flow-engine flows'
```

The CLI resolves `--repo`, `--artifacts`, `--diff-file` and `--brief` against the folder you ran the command from. pnpm passes that folder to the CLI as `INIT_CWD`.

The [root README](../../README.md#commands) lists the commands and options.

## Files

| File | What it does |
|---|---|
| `src/index.ts` | Parses arguments, loads the config, picks the flow and writes run output. |
| `src/drive.ts` | Runs a checkpointed graph to the end. At each `interrupt()`, it shows the `GateRequest`, reads your decision and resumes the graph with `Command({ resume })`. With `--yes`, it picks the first option. |

`drive` is the only part that knows about the terminal. To answer gates from Slack or a phone instead, replace `drive` and leave the graphs alone. [docs/wiring.md](../../docs/wiring.md#4-persistent-runs-and-gates-away-from-the-terminal) sketches how.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. For `review`, the verdict was `pass`. |
| 1 | Bad arguments, a missing task or an error. |
| 2 | `review` only: the verdict was `fix` or `escalate`. |
