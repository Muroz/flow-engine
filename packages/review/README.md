# @flows/review

The review flow reads a diff and returns a verdict (`pass`, `fix` or `escalate`) and a one-screen Markdown report. It runs on its own through `flows review`, and delivery runs it as a subgraph after every attempt whose checks pass.

## How a review works

1. **Gather context.** It reads the diff, the task and its acceptance criteria when you pass `--task`, the project's ADRs, its conventions and its standards files.
2. **Specialists review.** Up to six reviewer models read the diff in parallel, each from one angle: does it meet the task (`spec`), is it correct, is it secure, is it tested, does it follow the architecture, and are its docs clear. Each sees only the context its job needs, and each returns findings: a problem, where it is, how severe it is and why.
3. **Merge duplicates.** Findings from different reviewers about the same lines become one finding.
4. **Verify.** Another model checks each finding against the whole file, the ADRs, the standards and what earlier rounds asked for. It throws out findings it can show are wrong, and flags ones that would break a rule or undo an earlier fix.
5. **Triage.** A judge rates how severe each remaining finding is, on one shared scale. See [Severity](#severity).
6. **Decide.** Plain code, not a model, turns the findings into a verdict: `escalate` when a person must decide, `fix` when something major is left, and `pass` otherwise. See [Verdict rules](#verdict-rules).
7. **Report.** It writes a one-screen report: the verdict, the findings that matter and each step's model and cost.

In delivery, each `fix` finding goes back to the coding agent as a note, and an `escalate` stops the loop and asks you.

## Graph

```
START → loadContext ─┬─► reviewer(spec)         ─┐
                     ├─► reviewer(correctness)  ─┤
                     ├─► reviewer(security)     ─┤
                     ├─► reviewer(tests)        ─┼─► aggregate → verify → triage → decide → writeReport → END
                     ├─► reviewer(architecture) ─┤
                     ├─► reviewer(docs)         ─┤
                     └─(no specialist applies)───┘
```

| Node | Kind | What it does |
|---|---|---|
| `loadContext` | Deterministic | Reads the diff, the changed files, the task, the ADRs and the conventions. |
| `reviewer` | Generative | One specialist. `Send` runs it once per active specialist, in parallel. |
| `aggregate` | Deterministic | Merges findings that point at the same file, within three lines, with overlapping titles. The survivor keeps the higher severity and records who else raised it. |
| `verify` | Generative | Checks each merged finding, in parallel, before anyone acts on it. It reads what a reviewer doesn't see: the whole file, every ADR and standard, and the findings of earlier rounds. It calls each finding `valid`, `invalid` or `conflict`, and may cap its severity. A `valid` call that quotes no line or rule counts as `invalid`. When the call fails or the reply has no verdict, the finding goes on unchecked. |
| `triage` | Judge | Rates how severe each finding is, from the finding, the task and the diff lines within five of the finding's line. It sees only those lines because, given a whole file, it rated a missing test as a blocker when a leaked secret sat nearby. For a finding the verifier couldn't check, it also asks whether the finding is real, and agreement between reviewers raises that confidence by 0.1 per extra reviewer. Findings the verifier ruled out skip the judge. See [Which findings are kept](#which-findings-are-kept). |
| `decide` | Deterministic | Turns the triaged findings into a verdict, in plain code. |
| `writeReport` | Deterministic | Writes the Markdown report, including a provenance section with every node's model and cost. |

## Routing

The review flow has one conditional edge. After `loadContext`, `fanOut` in `src/graph.ts` sends one `reviewer` branch per specialist that applies to this diff (see [Specialists](#specialists)). When none applies, it goes straight to `aggregate`. Every other edge is static, and the flow never loops: delivery decides what to do with the verdict.

## Which findings are kept

`triage` marks a finding as kept when all of these hold. Only kept findings count toward the verdict, and in delivery only they go to the agent as notes.

- The verifier called it `valid`, or couldn't check it.
- It doesn't undo a fix from an earlier round. Such a finding goes to you instead, through the first verdict rule.
- Its confidence is at least `review.minConfidence`. A finding the verifier called `valid` always passes this test, so the setting only filters unchecked findings.
- Its severity, after the verifier's cap and the cap in `SEVERITY_CAP`, isn't in `review.dropSeverities`.

## Verdict rules

`decideVerdict` in `src/nodes/decide.ts` checks four rules in order:

1. A conflict gives `escalate`. A conflict is a finding the verifier says clashes with an ADR, a standard or an earlier round, or one the reviewer says would undo an earlier fix. Fixing either side would only bring the other back next round, so a person decides once.
2. A finding at or above `review.escalateAtSeverity` that the judge is less sure of than `review.minConfidence` gives `escalate`. Findings the verifier ruled out never count here.
3. Any kept finding rated `major` or `blocker` gives `fix`.
4. Anything else gives `pass`, with a count of minor comments.

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

To add a specialist:

1. Add an entry to `REVIEWERS` in `src/reviewers.ts`, with its `view` and, if it needs one, `appliesTo`.
2. Add `prompts/review/<id>.md`. End it with `{{output_format}}` so it returns the shared JSON shape.
3. List the ID under `review.reviewers` in the project's `.flows.yaml`.
4. Add an offline heuristic in `src/mocks.ts` if you want it to find something in offline runs.

## Project standards

`standards` in `.flows.yaml` lists the project's own rules files, such as a module layout or a testing standard, and the reviewers that check against each one:

```yaml
standards:
  - path: docs/standards/testing.md
    reviewers: [tests]
```

`loadContext` reads the files, and each reviewer's prompt gets only its own under "PROJECT STANDARDS". A change that breaks a standard is a major finding. A reviewer with none listed sees "(none)".

## Severity

Reviewers and the triage judge use the same scale. `prompts/review/_output.md` defines it for the reviewers, and `SEVERITY_QUESTION` in `src/nodes/triage.ts` for the judge:

- **blocker:** a security hole in code that runs, data loss, or a broken build.
- **major:** a bug in code that runs, a missed acceptance criterion, or a broken ADR or project standard.
- **minor:** hardening beyond what the task asks, unusual ways around a rule, or unclear docs.
- **nit:** taste.

Anything that neither the task nor an ADR nor a standard asks for is minor at most. So are requests to build something a later task will build. Docs findings are capped at minor in code, by `SEVERITY_CAP` in `src/nodes/triage.ts`, whatever the judge says. The judge sees the task's title and acceptance criteria, so it can tell.

## Use it from code

```ts
import { createDeps, loadConfig } from "@flows/core";
import { runReview } from "@flows/review";

const deps = createDeps(loadConfig("/path/to/project"));
const state = await runReview(deps, { diff, label: "PR 42" });
console.log(state.verdict, state.report);
```

## Tests

`test/review.test.ts` covers dedupe, the verifier's replies, the verdict rules, specialist selection and `fileDiff`. Run it with `pnpm test` from the engine root.
