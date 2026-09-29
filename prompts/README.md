# Prompts

Each generative node has one Markdown prompt here, so you can read, diff and test a prompt without touching graph code. `loadPrompt("review/security")` reads `review/security.md`, and `render` fills in each `{{placeholder}}`. `render` leaves unknown placeholders in the text, so a typo shows up in the model's input instead of failing silently.

| File | Node | Placeholders |
|---|---|---|
| `review/_output.md` | Every review specialist, as `{{output_format}}` | none |
| `review/spec.md` | `reviewer` (spec) | `task_title`, `acceptance_criteria`, `diff`, `output_format` |
| `review/correctness.md` | `reviewer` (correctness) | `diff`, `output_format` |
| `review/security.md` | `reviewer` (security) | `diff`, `output_format` |
| `review/tests.md` | `reviewer` (tests) | `changed_files`, `acceptance_criteria`, `diff`, `output_format` |
| `review/architecture.md` | `reviewer` (architecture) | `decisions`, `conventions`, `diff`, `output_format` |
| `delivery/plan.md` | `makePlan` | `task`, `acceptance_criteria`, `adrs` |
| `planning/questions.md` | `askQuestions` | `brief` |
| `planning/requirements.md` | `writeRequirements` | `brief` |
| `planning/option.md` | `proposeOption` | `angle`, `requirements`, `brief` |
| `planning/compare.md` | `compareOptions` | `requirements`, `options` |
| `planning/adrs.md` | `writeAdrs` | `chosen`, `requirements` |
| `planning/breakdown.md` | `breakdown` | `requirements`, `adrs`, `previous`, `gaps` |

Every prompt asks for a single JSON object, and the node parses it with `parseJsonReply`. If you change the JSON shape in a prompt, change the parsing in the node too.

The Claude Code agent's prompt isn't here. `implement` in `packages/delivery/src/nodes.ts` builds it from the task, because it is mostly data.

Before you tune a review prompt, build an eval set of real diffs with known issues. Without one, you can't tell whether a change helped.
