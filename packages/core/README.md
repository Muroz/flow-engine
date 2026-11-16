# @flows/core

Core holds everything the flows share. It has no LangGraph code, so every flow can use it and you can test it on its own.

| File | What it holds |
|---|---|
| `types.ts` | The contracts between flows: `PlannedTask`, `Finding`, `Verification`, `TriagedFinding`, `PriorFinding`, `Verdict` and `LogEntry`. `PriorFinding` is how delivery passes earlier rounds' findings back into review. |
| `config.ts` | `loadConfig`, which reads `.flows.yaml` and fills in defaults, and `modelFor`, which picks the model for a role. [docs/configuration.md](../../docs/configuration.md) lists every setting. |
| `categories.ts` | The triage table review uses to set a finding's severity from its kind. `DEFAULT_CATEGORIES` is the built-in table, and `parseCategories` merges a project's `review.categories` over it and rejects bad entries. `categoryWarnings` warns when the table grows past `CATEGORY_WARN_AT` kinds, and `appendTriageGaps` writes `runs/<project>/triage-gaps.md`. See [Severity](../review/README.md#severity). |
| `deps.ts` | `createDeps`, which builds the model client and judge once per run and checks that every role it will call has a backend. Nodes get them through `FlowDeps` and never read environment variables or build clients themselves. With `--claude-code`, `withClaudeCodeModels` moves every role to Claude Code. `assertClaudeCodeAllowed` refuses Claude Code on a project whose `openrouter.provider.only` leaves out `anthropic`; see [docs/configuration.md](../../docs/configuration.md#models). |
| `models.ts` | `OpenRouterClient`, `ClaudeCodeClient`, `RoutingModelClient`, `MockModelClient` and `parseJsonReply`. |
| `judge.ts` | The judge interface and its three engines: `JevJudge`, `LlmJudge` and `MockJudge`. |
| `artifacts.ts` | Reads tasks, standards, the PRD and diffs, and writes run output under `runs/`. |
| `adrs.ts` | Reads ADRs with their status, relations and numbered clauses, resolves the ADRs a task needs, writes new ADRs from `templates/adr.md`, and checks each file against the template and each link on both sides. See [ADR format](#adr-format). |
| `prompts.ts` | `loadPrompt` reads `prompts/<name>.md`, and `render` fills in `{{placeholders}}`. `writingRules(audience)` returns the shared writing rules for the project owner or for developers. Walkthroughs, the Claude Code agent's prompt and the `docs` reviewer use it. |
| `gates.ts` | `GateRequest` and `GateDecision`, the shapes a gate sends and gets back. |
| `log.ts` | `logEntry` and `totalCost`. |

## Judges

A judge answers small typed questions about one piece of state. It never writes prose, so code, not a model, decides what happens with the answer.

```ts
import { choice, noul } from "@flows/core";

const a = await deps.judge.ask(
  { finding, code },
  {
    real: noul("Is this a real problem introduced by this change?"),
    kind: choice("Which kind of problem is this?", { bug: "a bug in code that runs", security: "a security hole" }),
  },
);
// a.real.p is a probability; a.kind.choice is "bug" or "security".
```

There are three question types:

- `noul(instructions)` asks yes or no and returns `{ p }`, the probability of yes.
- `choice(instructions, options)` picks one option and returns `{ choice, confidence, probabilities }`. Jev gives a probability for every option in the same answer, at no extra cost. The LLM judge leaves `probabilities` out.
- `score(instructions, levels)` places the state on an ordered scale and returns `{ level, index, confidence }`.

`judgeEngine` in `deps.ts` picks the engine. `jev` and `llm` are explicit. `auto` picks Jev when `TYPESAFE_API_KEY` is set and the project has no `openrouter.provider.only` list, because Jev calls go straight to TypeSafe and that list can't restrict them. See [docs/configuration.md](../../docs/configuration.md#openrouter-and-judge).

## Model clients

Every generative node calls `deps.model.complete` with a model ID. On a live run, `deps.model` is a `RoutingModelClient`. It sends IDs that start with `claude-code/` to `ClaudeCodeClient` and everything else to `OpenRouterClient`, so nodes never know which backend answered. The LLM judge uses the same client, so `models.judge` can sit on either backend.

`OpenRouterClient` retries a call that fails for a reason that clears up on its own: a rate limit (429), a server error (5xx) or a 402 for the in-flight credit budget. It waits as long as OpenRouter's `Retry-After` says, at most three minutes, or else 5, 10 and 20 seconds, and gives up after three retries. It prints a line for each wait. A 402 for no credit left, and any other 4xx, fails at once.

`ClaudeCodeClient` runs `claude -p` once per call with tools, settings and MCP servers turned off, and reads the reply from its JSON output. It takes a `ClaudeRunner` so tests can swap in a fake `claude`, as `test/models.test.ts` does.

To add another backend, implement `ModelClient`, give it a prefix and add a route in `RoutingModelClient` and `createDeps`.

## ADR format

`adrs.ts` reads `docs/adr/NNNN-*.md` in the artifacts folder and skips other files, such as a README. Every ADR follows Nygard's structure, filled from `templates/adr.md`:

```markdown
# ADR-0006: Scanned repos are untrusted

Date: 2026-11-15

## Status
Accepted

## Relations
- Amends [ADR-0001](0001-read-git-state.md) clause 2: allows reading config files to find filter drivers.

## Context
Why a decision is needed.

## Decision
1. One rule a reviewer can check.
2. The next rule.

## Consequences
What becomes easier or harder.
```

- **Title:** `# ADR-NNNN: <the decision>`. The number matches the file name.
- **Date:** the day the ADR was written, as `YYYY-MM-DD`.
- **Status:** `Proposed`, `Accepted`, `Superseded` or `Deprecated`, optionally followed by more words, such as `Accepted on 2026-11-20`. The parser reads the first word.
- **Relations:** `None.`, or one line per link. The kinds are `Supersedes`, `Superseded by`, `Amends`, `Amended by` and `Related to`. Each relation is recorded on both ADRs.
- **Decision:** a numbered list of clauses, each one rule. A clause can wrap onto lines indented by two spaces or more. Anything else in the section, such as a `###` subsection, is a format problem.

Tasks, findings and other ADRs cite a clause as `ADR-0001 clause 2`, or `ADR-0001 clauses 2 and 3`. An accepted ADR's text never changes. To change part of a decision, write a new ADR whose Relations say `Amends [ADR-0001](...) clause 2`, and add `Amended by [ADR-0006](...) clause 2` to ADR-0001. Both lines carry the amended ADR's clause numbers. To replace a whole decision, use `Supersedes` and set the old ADR's status to `Superseded`.

`loadAdrs(config, ids)` follows the links when it gathers a task's ADRs. It swaps a superseded ADR for its replacement, adds any ADRs that amend one it returns, and skips deprecated ones. An id can name a clause, such as `ADR-0001 clause 2`; the whole ADR comes back. Without `ids`, it returns every ADR in force.

`adrBrief` renders an ADR for a model: the heading, then each clause by number, with a note on each clause another ADR amends. Every flow uses it, so the planner, the coding agent, the reviewers and the verifier all see the same numbering.

`renderAdr` writes a new ADR from the template, and `adrTemplateGuide` fills the template with instructions for a coding agent that has to write one by hand.

`checkAdrs` lists format problems, one-sided links, links whose clauses differ between the two sides, amendments that name no clause or a clause that doesn't exist, clause citations that point at nothing, and statuses that disagree with their relations. `flows adrs` prints the ADRs and those problems.

## Mocks

`MockModelClient` and `MockJudge` return canned answers. Each flow registers its own in `mocks.ts`, keyed on the `tag` a node sends with each model call, such as `review.security` or `delivery.plan`. A request that no responder handles gets an empty JSON object or a placeholder string.

## Tests

`test/adrs.test.ts` covers relations and clause numbers, the template, format problems, how a task's ADRs follow supersessions and amendments, and `checkAdrs`. `test/deps.test.ts` covers how the judge engine and backends are picked, `--claude-code` and the Anthropic guard. `test/judge.test.ts` covers how Jev scores map to levels. `test/models.test.ts` covers `ClaudeCodeClient`, `RoutingModelClient` and the OpenRouter retries. `test/standards.test.ts` covers project standards and `writingRules`. Run them with `pnpm test` from the engine root.
