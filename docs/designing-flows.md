# Designing flows

This guide is for adding a flow or changing how one works. To use the flows, start with the [root README](../README.md).

## Package layout

Each flow package has at least these five source files and folders. Copy the pattern when you add a flow:

| File | What goes in it |
|---|---|
| `state.ts` | Plain TypeScript types for the state, with no framework imports. |
| `nodes/` | One file per node: a function that takes state and returns a partial update, with a JSDoc that gives its kind and the state keys it reads and writes. Helpers only one node uses live in its file, and helpers several share live in `shared.ts`. `routing.ts` holds the routing functions for conditional edges, and `index.ts` lists the nodes and re-exports them. You can test all of them without building a graph. |
| `graph.ts` | The LangGraph `Annotation` (the state plus its reducers) and the wiring. The header comment holds the diagram. A fan-out function that needs the built dependencies, such as review's `fanOut`, can live here too. |
| `mocks.ts` | Offline responses, keyed on each model call's `tag`, so every node and edge runs with no network. |
| `index.ts` | What other packages may import: the state types, the nodes, the graph builder and the mock registration. |

A flow adds its own files when one job grows large enough to read on its own: `reviewers.ts` holds review's specialists, `summaries.ts` holds planning's gate summaries, and delivery keeps `walkthrough.ts` and its agents under `agents/`.

## Five things to define

Every graph framework asks you to define the same five things.

1. **State.** Write the type first. Include the input, the artifacts (a path plus a short summary), loop counters, gate decisions and a log. If you can't write the state, you don't understand the flow yet.
2. **Nodes.** Give each node one of four kinds before you write it, and push as much work as you can into the first kind:
   - Deterministic: plain code such as git, tests, file I/O and policy.
   - Generative: a model call, through OpenRouter or Claude Code, that writes text or code.
   - Judge: a Jev or LLM-judge call that returns a typed decision, such as yes or no, one of N or a score.
   - Human: a gate, built on `interrupt()`.
3. **Edges.** There are four kinds:
   - Static: A always leads to B.
   - Conditional: a function of state picks the next node.
   - Fan-out: `Send` starts one branch per item, and a reducer merges what they return.
   - Loop: always with a stop rule.

   Put a judge or plain policy code in front of every conditional edge.
4. **Gates.** Gate at the ends, on intent and outcome, not in the middle. Let risk decide whether a gate opens at all: delivery shows you a plan only when its risk is above `delivery.autoApproveRisk`. The one mid-flow gate worth having is the one that opens when the flow is stuck, as delivery's escalate gate does. Keep every gate summary to one screen.
5. **Context.** Give each node a view of the state, not all of it. `packages/review/src/reviewers.ts` shows how. Pass large things by path, and summarise at boundaries. The model that checks the work should differ from the model that made it.

## LangGraph rules

Three LangGraph rules have already caused bugs here:

- **Parallel writes need reducers.** Any field that fan-out branches write needs a reducer that merges them. Use `concat` to collect, as `rawFindings` and `log` do. When branches can run again, merge by ID instead, as `mergeOptions` does for planning's `options`, so a rerun replaces entries rather than adding copies. Don't return a `concat` field from a later node unless you mean to append to it.
- **A resumed node runs again from its first line.** After `interrupt()`, LangGraph re-runs the whole node. Keep model calls in the node before the gate, not in the gate node.
- **A node can't share a name with a state key.** LangGraph refuses to build the graph. That is why the review node that writes `report` is called `writeReport`.

## Adding a flow

1. **Create the package** under `packages/<flow>/` with the five files above and a `package.json` like planning's: the name `@flows/<flow>`, `exports` pointing at `./src/index.ts`, and `@flows/core` (`workspace:*`) and `@langchain/langgraph` as dependencies. Add it to `@flows/cli`'s dependencies and run `pnpm install`. The root `tsconfig.json` already type-checks every package.
2. **Call models through `deps`.** A generative node calls `deps.model.complete({ tag, model: modelFor(deps.config, role), system, user })`. Pick an existing role (`planner`, `reviewer`, `verifier` or `judge`) or add one to `ProjectConfig.models` in `packages/core/src/config.ts`. The `tag`, such as `review.security`, picks the mock response offline. Never read environment variables or build a client in a node.
3. **Ask judges through `deps`.** A judge node calls `deps.judge.ask(state, { name: noul(...) })`, with `noul`, `choice` or `score` from `@flows/core`. Code, not the judge, decides what the answer means.
4. **Put prompts in `prompts/<flow>/`.** Load them with `loadPrompt("<flow>/<name>")` and fill them with `render`. Add each one to the table in [prompts/README.md](../prompts/README.md).
5. **Build gates with `interrupt()`.** A gate node calls `interrupt(request)` with a `GateRequest` from `packages/core/src/gates.ts`: a `gate` name, a `title`, a one-screen `summary`, the `options` and, if there is more to read, a `detailPath`. The first option is what `--yes` picks. It gets back a `GateDecision` with the `decision` and any `notes`.
6. **Log every node.** Return `log: [logEntry("<flow>.<node>", { model, costUsd, note, details })]`. The CLI prints one progress line per node from the last log entry, with its cost, and up to ten `details` below it. For lines while a node runs, such as an agent's tool calls, call `config.writer?.({ line })` with the node's second argument, as `say` in delivery's `nodes/shared.ts` does.
7. **Register mocks.** Export a `register<Flow>Mocks(deps)` from `mocks.ts`. When `deps.model` is a `MockModelClient`, it adds responders with `register`, keyed on your tags; when `deps.judge` is a `MockJudge`, it adds rules with `rule`. Call it in `packages/cli/src/index.ts` next to the others.
8. **Compile with the checkpointer you're given.** Take a `checkpointer` option and pass it to `compile`. The CLI passes its SQLite saver, which `pause`, `back` and `flows resume` need. A flow without gates, such as review, can skip it.
9. **Add a command.** In `packages/cli/src/index.ts`, build the graph and run it with `runGated`, which drives the gates in the terminal and saves the run for `resume`. A flow without gates can call `graph.invoke` instead.
10. **Test the policy.** Test each routing function directly with a hand-built state, as `packages/delivery/test/routing.test.ts` does. Test nodes with the mock clients.
11. **Add a sample run.** Add a script such as `<flow>:sample` to `package.json` that runs the flow with `--offline`, and a step for it in `scripts/verify.sh`.
12. **Document it.** Write `packages/<flow>/README.md` with a plain-language account of the flow, the graph, a node table and a routing table, as the other flow READMEs do, and add the flow to the root README.

## Where the tools fit

| Layer | Tool | Code |
|---|---|---|
| Generative nodes | OpenRouter or local Claude Code, picked per role by its model ID in `.flows.yaml`. `openrouter.provider` enforces a client's data policy on OpenRouter calls. | `packages/core/src/models.ts` |
| Judge nodes | Jev asks `noul` (yes or no), `choice` and `score` questions over one piece of state, several in one call. It calls TypeSafe directly, because OpenRouter only offers Jev as a model router, without these question types. Without a Jev key, or on a project with a provider allow-list, an LLM judge with the same interface takes over. | `packages/core/src/judge.ts` |
| Coding agent | Claude Code, headless, in one git worktree per task, or the `diff-file` agent, which replays a fixed diff in the same kind of worktree. | `packages/delivery/src/agents/` |
| Orchestration | LangGraph.js: `StateGraph`, `Send` and `interrupt`. The CLI supplies the checkpointer, a SQLite saver at `runs/checkpoints.db`. | `packages/*/src/graph.ts`, `packages/cli/src/runs.ts` |
| Knowledge | ADRs and `tasks.yaml`. | `packages/core/src/adrs.ts`, `packages/core/src/artifacts.ts` |
