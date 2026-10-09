# @flows/review

The review flow reads a diff and returns a verdict (`pass`, `fix` or `escalate`) and a one-screen Markdown report. It runs on its own through `flows review`, and delivery runs it as a subgraph after every attempt.

## Graph

```
START → loadContext ─┬─► reviewer(spec)         ─┐
                     ├─► reviewer(correctness)  ─┤
                     ├─► reviewer(security)     ─┼─► aggregate → triage → decide → writeReport → END
                     ├─► reviewer(tests)        ─┤
                     ├─► reviewer(architecture) ─┤
                     └─► reviewer(docs)         ─┘
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

Each specialist sees only its own view of the context. That keeps prompts short and stops reviewers wandering outside their job. Each one also gets the project standards that `.flows.yaml` lists for it. See [Project standards](#project-standards).

| ID | Sees | Runs when |
|---|---|---|
| `spec` | Task title, acceptance criteria, diff | The run has a task with acceptance criteria. |
| `correctness` | Diff | Always. |
| `security` | Diff | Always. |
| `tests` | Changed files, acceptance criteria, diff | Always. |
| `architecture` | ADR decisions, conventions, diff | The project has ADRs, conventions or standards listed for it. |
| `docs` | Writing rules for developers, doc files, and the code hunks that add comments | The diff changes a Markdown or text file, or adds a comment line. |

## Project standards

`standards` in `.flows.yaml` lists the project's own rules files, such as a module layout or a testing standard, and the reviewers that check against each one:

```yaml
standards:
  - path: docs/standards/testing.md
    reviewers: [tests]
```

`loadContext` reads the files, and each reviewer's prompt gets only its own under "PROJECT STANDARDS". A change that breaks a standard is a major finding. A reviewer with none listed sees "(none)".

## Severity

Reviewers and the triage judge use the same scale. `prompts/review/_output.md` defines it for the reviewers, and `SEVERITY_QUESTION` in `src/nodes.ts` for the judge:

- **blocker:** a security hole in code that runs, data loss, or a broken build.
- **major:** a bug in code that runs, a missed acceptance criterion, or a broken ADR or project standard.
- **minor:** hardening beyond what the task asks, unusual ways around a rule, or unclear docs.
- **nit:** taste.

Anything that neither the task nor an ADR nor a standard asks for is minor at most. So are requests to build something a later task will build. Docs findings are capped at minor in code, by `SEVERITY_CAP` in `src/nodes.ts`, whatever the judge says. The judge sees the task's title and acceptance criteria, so it can tell.

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
