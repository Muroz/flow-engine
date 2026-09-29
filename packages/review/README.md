# @flows/review

The review flow reads a diff and returns a verdict (`pass`, `fix` or `escalate`) and a one-screen Markdown report. It runs on its own through `flows review`, and delivery runs it as a subgraph after every attempt.

## Graph

```
START → loadContext ─┬─► reviewer(spec)         ─┐
                     ├─► reviewer(correctness)  ─┤
                     ├─► reviewer(security)     ─┼─► aggregate → triage → decide → writeReport → END
                     ├─► reviewer(tests)        ─┤
                     └─► reviewer(architecture) ─┘
```

| Node | Kind | What it does |
|---|---|---|
| `loadContext` | Deterministic | Reads the diff, the changed files, the task, the ADRs and the conventions. |
| `reviewer` | Generative | One specialist. `Send` runs it once per active specialist, in parallel. |
| `aggregate` | Deterministic | Merges findings that point at the same file, within three lines, with overlapping titles. The survivor keeps the higher severity and records who else raised it. |
| `triage` | Judge | Asks the judge, per finding, whether it is real and how severe it is. Agreement between reviewers raises confidence by 0.1 per extra reviewer. |
| `decide` | Deterministic | Turns the triaged findings into a verdict, in plain code. |
| `writeReport` | Deterministic | Writes the Markdown report, including a provenance section with every node's model and cost. |

## Verdict rules

`decideVerdict` in `src/nodes.ts` checks three rules in order:

1. A finding at or above `review.escalateAtSeverity` that the judge is less sure of than `review.minConfidence` gives `escalate`. A human should look.
2. Any kept finding rated `major` or `blocker` gives `fix`.
3. Anything else gives `pass`, with a count of minor comments.

`flows review` exits with code 0 on `pass` and 2 on `fix` or `escalate`.

## Specialists

Each specialist sees only its own view of the context. That keeps prompts short and stops reviewers wandering outside their job.

| ID | Sees | Runs when |
|---|---|---|
| `spec` | Task title, acceptance criteria, diff | The run has a task with acceptance criteria. |
| `correctness` | Diff | Always. |
| `security` | Diff | Always. |
| `tests` | Changed files, acceptance criteria, diff | Always. |
| `architecture` | ADR decisions, conventions, diff | The project has ADRs or conventions. |

To add a specialist:

1. Add an entry to `REVIEWERS` in `src/reviewers.ts`, with its `view` and, if it needs one, `appliesTo`.
2. Add `prompts/review/<id>.md`. End it with `{{output_format}}` so it returns the shared JSON shape.
3. List the ID under `review.reviewers` in the project's `.flows.yaml`.
4. Add an offline heuristic in `src/mocks.ts` if you want it to find something in offline runs.

## Use it from code

```ts
import { createDeps, loadConfig } from "@flows/core";
import { runReview } from "@flows/review";

const deps = createDeps(loadConfig("/path/to/project"));
const state = await runReview(deps, { diff, label: "PR 42" });
console.log(state.verdict, state.report);
```

## Tests

`test/review.test.ts` covers dedupe, the verdict rules, specialist selection and `fileDiff`. Run it with `pnpm test` from the engine root.
