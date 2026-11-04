# Designing flows

This guide is for adding a flow or changing how one works. To use the flows, start with the [root README](../README.md).

## Package layout

Each flow package has the same four source files. Copy the pattern when you add a flow:

| File | What goes in it |
|---|---|
| `state.ts` | Plain TypeScript types for the state, with no framework imports. |
| `nodes.ts` | Node functions that take state and return a partial update, plus the routing functions. You can test them without building a graph. |
| `graph.ts` | The LangGraph `Annotation` (the state plus its reducers) and the wiring. The header comment holds the diagram. |
| `mocks.ts` | Offline responses, so every node and edge runs with no network. |

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
4. **Gates.** Gate at the ends (intent and outcome), not in the middle. Let risk decide: low risk with high confidence goes ahead, and anything else waits for you. Keep every gate summary to one screen.
5. **Context.** Give each node a view of the state, not all of it. `packages/review/src/reviewers.ts` shows how. Pass large things by path, and summarise at boundaries. The model that checks the work should differ from the model that made it.

## LangGraph rules

Three LangGraph rules have already caused bugs here:

- **Parallel writes need reducers.** Any field that fan-out branches write needs a `concat` reducer, as `rawFindings`, `options` and `log` have. Don't return such a field from a later node unless you mean to append to it.
- **A resumed node runs again from its first line.** After `interrupt()`, LangGraph re-runs the whole node. Keep model calls in the node before the gate, not in the gate node.
- **A node can't share a name with a state key.** LangGraph refuses to build the graph. That is why the review node that writes `report` is called `writeReport`.

## Where the tools fit

| Layer | Tool | Code |
|---|---|---|
| Generative nodes | OpenRouter or local Claude Code, picked per role by its model ID in `.flows.yaml`. `openrouter.provider` enforces a client's data policy on OpenRouter calls. | `packages/core/src/models.ts` |
| Judge nodes | Jev asks `noul` (yes or no), `choice` and `score` questions over one piece of state, several in one call. It calls TypeSafe directly, because OpenRouter only offers Jev as a model router, without these question types. Without a Jev key, or on a project with a provider allow-list, an LLM judge with the same interface takes over. | `packages/core/src/judge.ts` |
| Coding agent | Claude Code, headless, in one git worktree per task. | `packages/delivery/src/agents/claude-code.ts` |
| Orchestration | LangGraph.js: `StateGraph`, `Send`, `interrupt` and a checkpointer. | `packages/*/src/graph.ts` |
| Knowledge | ADRs and `tasks.yaml`. | `packages/core/src/artifacts.ts` |
