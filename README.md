# flow-engine

Graph-based agent flows for solo development and consulting work, built on **LangGraph.js**, **OpenRouter** and **Jev**.

The goal is to stay in the loop without watching the details. You approve *intent* (scope, architecture, risky plans) and *outcomes* (merges). Everything in between runs as a graph, with judges on the edges and a paper trail on every node.

```
┌────────────────────┐   PRD, ADRs,        ┌────────────────────┐
│ planning           │── tasks.yaml ──────►│ delivery           │  one task at a time
│ rare, human-heavy  │                     │ mostly autonomous  │
└────────────────────┘                     │   ┌────────────┐   │
          ▲  replan proposals              │   │ review     │◄──┼── also standalone,
          └────────────────────────────────┤   │ (subgraph) │   │   on any diff/PR
                                           │   └────────────┘   │
                                           └────────────────────┘
```

## Quick start

```bash
bash scripts/verify.sh     # install, typecheck, tests, all sample flows → runs/verify.log
```

Or step by step:

```bash
corepack enable            # provides pnpm, if you don't have it
pnpm install
pnpm test                  # unit tests for nodes and routing

# Everything runs offline with deterministic mocks, no keys needed:
pnpm review:sample         # review a sample diff with 5 specialist reviewers
pnpm deliver:sample --yes  # plan → risk → implement → checks → review loop → stop rule
pnpm plan:sample --yes     # brief → questions → scope → 3 architectures → ADRs → tasks
```

Omit `--yes` and each human gate prompts you in the terminal instead. `flows review` exits with code 2 when the verdict isn't `pass` (the sample diff is deliberately bad), so it can gate CI. Run outputs go to `runs/<project>/<runId>/`, which is git-ignored and never written into the project repo.

To run for real, copy `.env.example` to `.env`, add your `OPENROUTER_API_KEY` (and `TYPESAFE_API_KEY` for Jev), and drop `--offline`:

```bash
pnpm flows review --repo ~/Coding/some-project --base main --head my-branch
pnpm flows review --repo ~/Coding/client-x --artifacts ~/Coding/workspaces/client-x --task T-004
pnpm flows tasks  --repo ~/Coding/some-project --done T-001,T-002   # what's ready next
```

## Layout

```
packages/
  core/        contracts (PlannedTask, Finding…), config, OpenRouter client,
               judges (Jev / LLM / mock), artifact I/O, prompts, gate types
  review/      ✅ complete — fan-out specialists → dedupe → judge triage → verdict → digest
  delivery/    🧩 wired end to end; `implement` is a stub for your coding agent
  planning/    🧩 wired end to end; prompts are first drafts
  cli/         `flows <review|deliver|plan|tasks>` + the gate driver
prompts/       one markdown file per generative node, versioned
examples/      sample-project: ADR, tasks.yaml, .flows.yaml, a deliberately bad diff
runs/          per-run outputs (git-ignored)
```

Each flow package has the same four files, and that's the pattern to copy for new flows:

| File | What goes in it |
|---|---|
| `state.ts` | Plain TypeScript types for the state. No framework imports. |
| `nodes.ts` | `(state) => Partial<state>` functions and routing functions. Testable without a graph. |
| `graph.ts` | The LangGraph `Annotation` (the state plus reducers) and the wiring. The diagram lives in the header comment. |
| `mocks.ts` | Offline responders, so every node and edge runs with no network. |

## How to design a flow

These are the five things every graph framework asks you to define.

1. **State.** Write the type first. Include the input, the artifacts (by reference plus a short summary), loop counters, gate decisions and a provenance log. If you can't write the state, you don't understand the flow yet.
2. **Nodes.** Classify each one before writing it:
   - *deterministic* (plain code: git, tests, file I/O, policy)
   - *generative* (OpenRouter: creates text or code)
   - *judge* (Jev: a typed decision such as yes/no, one-of-N or a score)
   - *human* (`interrupt()`)

   Push as much as possible into deterministic nodes.
3. **Edges.** There are four kinds:
   - static: A → B
   - conditional: a function of state
   - fan-out: `Send`, one per parallel branch, merged by a reducer
   - loops: always with a stop rule

   Put a judge (or plain policy code) in front of every conditional edge.
4. **Gates.** Gate at the *ends* (intent and outcome), not in the middle. Escalate by risk: low risk with high confidence proceeds, anything else pauses. Keep every gate summary to one screen.
5. **Context policy.** Each node gets a *view*, not the whole state (see `review/src/reviewers.ts`). Pass big things by path. Summarize at boundaries. The checker uses a different model or context from the maker.

Two LangGraph-specific rules that bite:

- **Parallel writes need reducers.** Any field written by fan-out branches needs a `concat` reducer (`rawFindings`, `options`, `log`). Never *return* such a field from a later node unless you mean to append to it.
- **Resumed nodes re-run from the top.** After `interrupt()`, the node runs again from its first line. Keep model calls in the node *before* the gate, not in the gate node itself.

## Where the tools fit

| Layer | Tool | Where |
|---|---|---|
| Generative nodes | OpenRouter (`models.*` per role in `.flows.yaml`; `openrouter.provider` enforces a client's data policy) | `core/src/models.ts` |
| Judge nodes | Jev: `noul`, `choice` and `score` over shared state, many questions in one call. Falls back to an LLM judge with the same interface. | `core/src/judge.ts` |
| Orchestration | LangGraph.js: `StateGraph`, `Send`, `interrupt`, checkpointer | `*/src/graph.ts` |
| Knowledge | ADRs and `tasks.yaml` today (a Backstage-style catalog or a graph DB later) | `core/src/artifacts.ts` |

## Project repos vs this repo

This repo is the engine and is your IP. Projects keep only their artifacts:

```
some-project/
  .flows.yaml          models, reviewers, thresholds, checks, conventions
  docs/prd.md
  docs/adr/0001-*.md
  plan/tasks.yaml
```

For client repos that shouldn't carry these files, keep them in a shadow workspace you own and pass `--artifacts <dir>`. Check each client's AI policy before sending their code to any model.

## Next steps

Step-by-step wiring (keys, CI, coding agent, remote gates) is in [docs/wiring.md](docs/wiring.md).


- [ ] Run `pnpm review:sample`, then point `flows review` at a real branch of your own.
- [ ] Plug a coding agent into `delivery/src/nodes.ts → implement` (Claude Code headless in a git worktree is the natural first choice).
- [ ] Swap `MemorySaver` for `@langchain/langgraph-checkpoint-sqlite` so gates can wait across restarts, then drive gates from somewhere other than the terminal.
- [ ] Add Langfuse tracing (`@langfuse/langchain` callback handler passed in the invoke config) and compare judge cost: Jev vs LLM.
- [ ] Add a golden-diff eval set under `evals/` for the review flow before tuning prompts.
- [ ] Let delivery write a *replan proposal* artifact when a task contradicts the plan, and have planning resume from `breakdown`.

## Notes

- Model slugs in the config are placeholders. Check [openrouter.ai/models](https://openrouter.ai/models).
- The Jev client uses the REST shape from TypeSafe's launch docs (`POST /v1/systemone`). If calls fail, check the current API reference; only `JevJudge` needs to change.
- Offline mocks are test doubles, not reviewers. They exist so you can see every node and edge run.
