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
| `verify` | Generative | Checks each merged finding, in parallel, before anyone acts on it. It reads what a reviewer doesn't see: the whole file, every ADR and standard, and the findings of earlier rounds. It judges the problem a finding names, not the fix it suggests, and calls each finding `valid`, `invalid` or `conflict`. It may cap the severity. When the problem is real but the reviewer's fix would break a rule, it calls the finding `valid` and gives a fix that keeps to the rules, which replaces the reviewer's suggestion and goes to the agent with the note. A `conflict` is a finding where every fix would break a rule or undo an earlier round. A `valid` call that quotes no line or rule counts as `invalid`. When the call fails or the reply has no verdict, the finding goes on unchecked. |
| `triage` | Judge | Names the kind of problem each finding describes, and the project's triage table sets the severity from that. See [Severity](#severity). The judge sees the finding's title, rationale and place, the task and the diff lines within five of the finding's line, but not the reviewer's severity or the verifier's evidence. For a finding the verifier couldn't check, it also asks whether the finding is real, and agreement between reviewers raises that confidence by 0.1 per extra reviewer. Findings the verifier ruled out skip the judge. See [Which findings are kept](#which-findings-are-kept). |
| `decide` | Deterministic | Turns the triaged findings into a verdict, in plain code. |
| `writeReport` | Deterministic | Writes the Markdown report, including a provenance section with every node's model and cost. |

## Routing

The review flow has one conditional edge. After `loadContext`, `fanOut` in `src/graph.ts` sends one `reviewer` branch per specialist that applies to this diff (see [Specialists](#specialists)). When none applies, it goes straight to `aggregate`. Every other edge is static, and the flow never loops: delivery decides what to do with the verdict.

## Which findings are kept

`triage` marks a finding as kept when all of these hold. Only kept findings count toward the verdict, and in delivery only they go to the agent as notes.

- The verifier called it `valid`, or couldn't check it.
- It doesn't undo a fix from an earlier round. Such a finding goes to you instead, through the first verdict rule.
- It isn't a conflict. A conflict goes to the report's "Conflicts for you to decide" section, and in delivery to the next gate.
- Its confidence is at least `review.minConfidence`. A finding the verifier called `valid` always passes this test, so the setting only filters unchecked findings.
- Its severity, after the verifier's cap and the cap in `SEVERITY_CAP`, isn't in `review.dropSeverities`.

## Verdict rules

`decideVerdict` in `src/nodes/decide.ts` checks four rules in order:

1. A conflict that would loop gives `escalate`. A conflict is a finding the verifier says clashes with an ADR, a standard or an earlier round, or one the reviewer says would undo an earlier fix. One against an earlier round always escalates, because fixing either side would only bring the other back next round. One against a rule escalates only at `review.escalateAtSeverity` or above. A smaller one doesn't hold up the fixes; it waits in the report for you.
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

Reviewers rate their own findings on the scale in `prompts/review/_output.md`. Triage doesn't ask the judge how severe a finding is. It asks which kind of problem the finding describes, a question of fact that gets steadier answers, and the triage table maps the kind to a severity. `DEFAULT_CATEGORIES` in `packages/core/src/categories.ts` holds the built-in table:

| Kind | Severity |
|---|---|
| `bug`: a bug in code that runs | major |
| `security`: a security hole in code that runs | blocker |
| `dataLoss`: data loss or corruption | blocker |
| `brokenBuild`: a broken build or a failing check | blocker |
| `missedCriterion`: a missed acceptance criterion | major |
| `brokenRule`: a broken ADR or project standard | major |
| `missingTests`: behaviour the change adds or alters has no tests | major |
| `beyondTask`: hardening or work beyond the task, the ADRs and the standards, such as something a later task builds, or an unusual way around a rule | minor |
| `docs`: documentation or code comments | minor |
| `taste`: style or taste | nit |

The judge is told to name only the problem the finding itself describes and to ignore worse problems in the code it sees, because other findings cover them. The report shows each finding's kind next to its severity. Two caps then apply: the verifier's `maxSeverity`, and `SEVERITY_CAP`, which holds docs findings at minor whatever the judge says.

### When no kind fits

The judge can also answer `other`. A finding marked `other` keeps the reviewer's own severity, capped at major, so a gap in the table can neither block a merge alone nor hide a problem. An answer outside the table counts as `other` too.

`triage` appends each finding that fits badly to `runs/<project>/triage-gaps.md`: those marked `other`, and those whose severity the judge was less than 0.5 sure of (`GAP_CONFIDENCE`). Jev gives a probability for every kind in the same answer, at no extra cost, and `severityCertainty` adds up the probability on every kind with the chosen kind's severity. A finding split between `bug` and `missedCriterion` is still a sure major, so it isn't logged; one split between `bug` and `security` is. The LLM judge gives no probabilities, so with it the judge's confidence in the kind stands in. Each line names the finding, the reviewer, the judge's answer, its certainty, the kinds of a different severity it also weighed, and the severity the finding kept. The triage progress line counts them too. Offline runs don't write the file, because their judge is fake. A pattern in the file is a kind worth adding to the project's table.

### Changing the table for a project

`review.categories` in `.flows.yaml` merges over the built-in table. A severity alone changes a built-in kind; `{ description, severity }` adds a kind or replaces one:

```yaml
review:
  categories:
    missingTests: minor
    pii:
      description: personal data logged or sent to a third party
      severity: blocker
```

The judge reads each description, so write it as a test the judge can apply to one finding. Every kind is one more option for the judge to tell apart, so a long table makes its choices less reliable: when the table has more than 15 kinds (`CATEGORY_WARN_AT`), every run prints a warning under its first line. Merge kinds that share a severity before adding more.

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
