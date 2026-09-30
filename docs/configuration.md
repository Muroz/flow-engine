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

A model ID picks its backend:

- An OpenRouter slug, such as `openai/gpt-5.5`, goes through OpenRouter. Check the list at [openrouter.ai/models](https://openrouter.ai/models).
- `claude-code/<model>` runs the local `claude` CLI with its own sign-in. The part after the slash goes to `claude --model`: an alias such as `sonnet`, `opus` or `haiku`, or a full model name. `claude-code/default` lets Claude Code pick.

Each role can use either backend, and one run can mix them.

| Key | Default | Used by |
|---|---|---|
| `models.default` | `anthropic/claude-sonnet-5.5` | Any role you don't set. |
| `models.planner` | `models.default` | Delivery's plan and every planning node except `compareOptions`. |
| `models.implementer` | `models.default` | The Claude Code agent, when `delivery.agent` is `claude-code`. A `claude-code/<model>` ID sets its `--model`. An OpenRouter slug leaves the choice to Claude Code. |
| `models.reviewer` | `openai/gpt-5.5` | The five review specialists and planning's `compareOptions`. Keep it on a different vendor from the implementer, so the checker isn't grading its own work. |
| `models.judge` | `openai/gpt-5.4-mini` | The LLM judge. Only used when Jev isn't. |

`createDeps` in `packages/core/src/deps.ts` checks the roles a run will call before it starts. It fails with the list of roles that need `OPENROUTER_API_KEY` when the key is missing. With `--claude-code`, or `FLOWS_CLAUDE_CODE=1`, it moves every role that isn't already on `claude-code/` to `claude-code/default`.

Each Claude Code call runs `claude -p` from the system temp folder with every tool off, no settings files, no MCP servers and no saved session. The model sees the node's system prompt and message and nothing else, so a project's `CLAUDE.md` never leaks in. Claude Code has no temperature setting, so the flows can't lower it for judges. The cost the report shows is Claude Code's list-price figure. On a Claude plan, that isn't what you pay.

Claude Code sends prompts straight to Anthropic, so `openrouter.provider` can't restrict it. A project whose `openrouter.provider.only` list leaves out `anthropic` refuses `claude-code/` models and `--claude-code`.

### OpenRouter and judge

| Key | Default | Meaning |
|---|---|---|
| `openrouter.provider` | `{ data_collection: deny }` | Sent to OpenRouter as its `provider` routing object. Use it to follow a client's AI policy, for example `only: [anthropic]`. It covers every OpenRouter call, but not Jev or Claude Code. An `only` list without `anthropic` also keeps Claude Code models out. |
| `judge.engine` | `auto` | `jev` uses Jev and fails without `TYPESAFE_API_KEY`. `llm` uses `models.judge` on its backend. `auto` uses Jev when the key is set and `openrouter.provider.only` isn't, and the LLM judge otherwise. |

Jev calls go straight to TypeSafe, not through OpenRouter, so `openrouter.provider` can't restrict them. Review triage sends Jev each finding with its file's diff. Delivery sends it the task and plan, and planning sends the brief and the task list. Setting `openrouter.provider.only` marks a project as having an AI policy: under `auto`, its judges then use the LLM judge, which follows that policy. Set `judge.engine: jev` on such a project only once the client has approved TypeSafe.

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
| `OPENROUTER_API_KEY` | Needed when at least one role in the run uses an OpenRouter slug. |
| `TYPESAFE_API_KEY` | Turns on Jev when `judge.engine` is `jev`, or `auto` with no `openrouter.provider.only`. |
| `FLOWS_OFFLINE` | `1` has the same effect as `--offline`. |
| `FLOWS_CLAUDE_CODE` | `1` has the same effect as `--claude-code`. |
