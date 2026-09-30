# @flows/core

Core holds everything the flows share. It has no LangGraph code, so every flow can use it and you can test it on its own.

| File | What it holds |
|---|---|
| `types.ts` | The contracts between flows: `PlannedTask`, `Finding`, `TriagedFinding`, `Verdict` and `LogEntry`. |
| `config.ts` | `loadConfig`, which reads `.flows.yaml` and fills in defaults, and `modelFor`, which picks the model for a role. [docs/configuration.md](../../docs/configuration.md) lists every setting. |
| `deps.ts` | `createDeps`, which builds the model client and judge once per run. Nodes get them through `FlowDeps` and never read environment variables or build clients themselves. |
| `models.ts` | `OpenRouterClient`, `MockModelClient` and `parseJsonReply`. |
| `judge.ts` | The judge interface and its three engines: `JevJudge`, `LlmJudge` and `MockJudge`. |
| `artifacts.ts` | Reads tasks, ADRs, the PRD and diffs, and writes run output under `runs/`. |
| `prompts.ts` | `loadPrompt` reads `prompts/<name>.md`, and `render` fills in `{{placeholders}}`. |
| `gates.ts` | `GateRequest` and `GateDecision`, the shapes a gate sends and gets back. |
| `log.ts` | `logEntry` and `totalCost`. |

## Judges

A judge answers small typed questions about one piece of state. It never writes prose, so code, not a model, decides what happens with the answer.

```ts
import { noul, score, SEVERITIES } from "@flows/core";

const a = await deps.judge.ask(
  { finding, code },
  {
    real: noul("Is this a real problem introduced by this change?"),
    severity: score("How severe is it if merged as-is?", SEVERITIES),
  },
);
// a.real.p is a probability; a.severity.level is one of SEVERITIES.
```

There are three question types:

- `noul(instructions)` asks yes or no and returns `{ p }`, the probability of yes.
- `choice(instructions, options)` picks one option and returns `{ choice, confidence }`.
- `score(instructions, levels)` places the state on an ordered scale and returns `{ level, index, confidence }`.

`judgeEngine` in `deps.ts` picks the engine. `jev` and `llm` are explicit. `auto` picks Jev when `TYPESAFE_API_KEY` is set and the project has no `openrouter.provider.only` list, because Jev calls go straight to TypeSafe and that list can't restrict them. See [docs/configuration.md](../../docs/configuration.md#openrouter-and-judge).

## Mocks

`MockModelClient` and `MockJudge` return canned answers. Each flow registers its own in `mocks.ts`, keyed on the `tag` a node sends with each model call, such as `review.security` or `delivery.plan`. A request that no responder handles gets an empty JSON object or a placeholder string.
