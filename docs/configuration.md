# Configuration

Each project keeps its flow settings in `.flows.yaml`. `loadConfig` in `packages/core/src/config.ts` reads it from the artifacts folder: the repo itself, or the folder you pass with `--artifacts`. Every key is optional. Without the file, every setting takes the default below.

## Example

```yaml
project: sample-project

models:
  default: anthropic/claude-sonnet-5.5
  reviewer: openai/gpt-5.5
  judge: openai/gpt-5.4-mini

openrouter:
  provider:
    data_collection: deny

judge:
  engine: auto

review:
  reviewers: [spec, correctness, security, tests, architecture]
  minConfidence: 0.6
  escalateAtSeverity: blocker
  dropSeverities: [nit]

delivery:
  maxAttempts: 3
  autoApproveRisk: low
  agent: diff-file
  checks:
    - npm test --silent

conventions:
  - Route handlers live in src/routes and stay thin; logic goes in src/services.
```

## Settings

### Project and paths

| Key | Default | Meaning |
|---|---|---|
| `project` | The repo folder's name | Names the run folder, `runs/<project>/`, and the worktree folder. Keep it unique across projects. |
| `artifacts` | The folder holding `.flows.yaml` | Where `docs/prd.md`, `docs/adr/` and `plan/tasks.yaml` live. A relative path resolves against the folder holding `.flows.yaml`. |

### Models

Model IDs are OpenRouter slugs. Check the list at [openrouter.ai/models](https://openrouter.ai/models).

| Key | Default | Used by |
|---|---|---|
| `models.default` | `anthropic/claude-sonnet-5.5` | Any role you don't set. |
| `models.planner` | `models.default` | Delivery's plan and every planning node except `compareOptions`. |
| `models.implementer` | `models.default` | Reserved for an OpenRouter-based agent. Claude Code picks its own model. |
| `models.reviewer` | `openai/gpt-5.5` | The five review specialists and planning's `compareOptions`. Keep it on a different vendor from the implementer, so the checker isn't grading its own work. |
| `models.judge` | `openai/gpt-5.4-mini` | The LLM judge. Only used when Jev isn't. |

### OpenRouter and judge

| Key | Default | Meaning |
|---|---|---|
| `openrouter.provider` | `{ data_collection: deny }` | Sent to OpenRouter as its `provider` routing object. Use it to follow a client's AI policy, for example `only: [anthropic]`. |
| `judge.engine` | `auto` | `jev` uses Jev and fails without `TYPESAFE_API_KEY`. `llm` uses `models.judge` through OpenRouter. `auto` uses Jev when the key is set and the LLM judge when it isn't. |

### Review

| Key | Default | Meaning |
|---|---|---|
| `review.reviewers` | All five | Which specialists run. `spec` only runs with a task that has acceptance criteria. `architecture` only runs when there are ADRs or conventions. |
| `review.minConfidence` | `0.6` | The judge drops findings it is less sure of than this. Raise it if reviews are noisy, and lower it if they miss things. |
| `review.escalateAtSeverity` | `blocker` | A finding this severe that the judge is unsure of goes to you instead of being dropped. `major` makes the flow ask you more often. |
| `review.dropSeverities` | `[nit]` | Severities that never reach you. Add `minor` to see only blocking issues. |

### Delivery

| Key | Default | Meaning |
|---|---|---|
| `delivery.agent` | `diff-file` | Who writes the code. `diff-file` replays the diff from `--diff-file`, or `--base...--head`, on every attempt, for demos and tests. `claude-code` runs Claude Code in a git worktree per task. `--offline` always uses `diff-file`. |
| `delivery.agentTools` | Read and edit tools, plus one `Bash(<check>)` rule per check | The Claude Code tool allow-list, in Claude Code's `--allowedTools` syntax. |
| `delivery.checks` | `[]` | Shell commands run after each attempt, in the agent's worktree when there is one and in the repo when there isn't. Each has ten minutes. With none, checks count as passed. |
| `delivery.maxAttempts` | `3` | The stop rule. After this many failed attempts, the flow asks you. |
| `delivery.autoApproveRisk` | `low` | Plans at or below this risk skip the plan gate. `none` shows you every plan. `medium` only stops for high-risk plans. |

### Conventions

| Key | Default | Meaning |
|---|---|---|
| `conventions` | `[]` | Free-text team rules. The architecture reviewer checks against them, and the Claude Code agent gets them in its prompt. |

## Environment variables

The CLI reads `.env` in the engine root. `.env.example` lists the variables.

| Variable | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | Needed for any run without `--offline`. |
| `TYPESAFE_API_KEY` | Turns on Jev when `judge.engine` is `auto` or `jev`. |
| `FLOWS_OFFLINE` | `1` has the same effect as `--offline`. |
