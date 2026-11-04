# @flows/planning

The planning flow turns a client brief into the artifacts that delivery and review read: `docs/prd.md`, `docs/adr/*.md` and `plan/tasks.yaml`. It asks for you more than the other flows do, because this is where your judgement matters most.

Every node runs, online and offline. The prompts in `prompts/planning/` are first drafts, so expect to rework them.

## Graph

```
START → intake → assessBrief ─(gaps)─► askQuestions → clarify (gate) ─┐
                     ▲  │ complete                                     │
                     └──┼──────────────────────────────────────────────┘
                        ▼
               writeRequirements → approveScope (gate) ─(revise)─┐
                     ▲                  │ approve                 │
                     └──────────────────┼─────────────────────────┘
                                        ▼ (fan-out, one per angle)
               proposeOption ‖ proposeOption ‖ proposeOption ◄──(revise)──┐
                                        ▼                                 │
               compareOptions ◄── adjustOption ◄──(adjust)────────────────┤
                      ▼                                                   │
               pickArchitecture (gate) ───────────────────────────────────┘
                      ▼ pick
               writeAdrs → breakdown ◄─┐
                              ▼        │ gaps, at most 2 rounds
                        checkCoverage ─┘
                              ▼
                        approvePlan (gate) → emit → END
```

| Node | Kind | What it does |
|---|---|---|
| `intake` | Deterministic | Reads the brief file. |
| `assessBrief` | Judge | Asks whether the brief names users, core flows, constraints and success. |
| `askQuestions` | Generative | Writes discovery questions for the gaps. |
| `clarify` | Gate | Shows you the questions. Options: `answered`, which adds your notes to the brief as answers and checks the brief again, or `proceed anyway`, which moves on to requirements. With no notes, the model makes assumptions and lists them. After two rounds, the flow moves on anyway. |
| `writeRequirements` | Generative | Writes numbered, testable requirements, each with a short title, a feature area and a priority of MVP or later. After a revise, it edits the existing list instead of starting over. |
| `approveScope` | Gate | Approve, revise with notes or discard. See [Reviewing scope](#reviewing-scope). |
| `proposeOption` | Generative | Runs three times in parallel, once per angle in `ARCH_ANGLES`: the simplest option, one built to scale and one that buys instead of building. |
| `compareOptions` | Generative | The reviewer model recommends one option. |
| `pickArchitecture` | Gate | Pick an option, revise all three, adjust one or discard. See [Choosing an architecture](#choosing-an-architecture). |
| `adjustOption` | Generative | Rewrites one option from your notes, then the options go back to `compareOptions`. |
| `writeAdrs` | Generative | Writes ADRs for the chosen option. |
| `breakdown` | Generative | Splits the work into tasks with dependencies and acceptance criteria. |
| `checkCoverage` | Judge and deterministic | One judge call asks whether each requirement is covered. Plain code finds tasks that trace to no requirement. Gaps send the breakdown back once; after that, open gaps go to you. |
| `approvePlan` | Gate | Shows the architecture, the ADR titles, task counts by risk and size, the tasks that can start first and any gaps still open. The full task list is in `plan.md`. Options: `approve`, or `discard`, which ends the run without writing anything. |
| `emit` | Deterministic | Writes the PRD, ADRs and `tasks.yaml`. |

Only MVP requirements reach the architecture, ADR, breakdown and coverage nodes. The PRD lists the others under "Later".

The model call and the gate always sit in separate nodes. When LangGraph resumes after a gate, it re-runs the gate node from its first line, so a model call in the same node would run, and cost, twice.

## Routing

Plain code in `src/nodes.ts` picks every branch. Each edge that isn't listed here is static.

| After | Condition | Goes to | Function |
|---|---|---|---|
| `assessBrief` | The judge calls the brief complete, you chose `proceed anyway`, or two discovery rounds have run | `writeRequirements` | `afterAssess` |
| `assessBrief` | Otherwise | `askQuestions` | `afterAssess` |
| `approveScope` | `approve` | `proposeOption`, once per angle | `afterScope` |
| `approveScope` | `revise` | `writeRequirements` | `afterScope` |
| `approveScope` | `discard` | END, nothing written | `afterScope` |
| `pickArchitecture` | A letter | `writeAdrs` | `afterPick` |
| `pickArchitecture` | `adjust` | `adjustOption` | `afterPick` |
| `pickArchitecture` | `revise` | `proposeOption`, once per angle | `afterPick` |
| `pickArchitecture` | `discard` | END, nothing written | `afterPick` |
| `checkCoverage` | A requirement isn't covered and `breakdown` has run fewer than two times | `breakdown` | `afterCoverage` |
| `checkCoverage` | Otherwise | `approvePlan` | `afterCoverage` |
| `approvePlan` | `approve` | `emit` | `afterPlanGate` |
| `approvePlan` | `discard` | END, nothing written | `afterPlanGate` |

## Reviewing scope

The scope gate groups requirements by feature area and shows one line per MVP requirement, such as `R-12 Drag to create a shift`. Requirements marked "later" appear only as a count per area. The full text of every requirement is in `scope.md` in the run folder, and the gate prints its path.

To change the scope, choose `revise` and write notes that name what to change:

```
R-12 later; drop R-30; R-4 mvp; Scheduling: add copy week forward
```

The model applies only those changes. It keeps every other requirement and its ID, and numbers new ones after the highest existing ID. The next gate starts with what changed, for example `Added R-43 · Removed R-30 · Moved to later R-12`.

## Choosing an architecture

The architecture gate shows each option in two lines: a one-sentence pitch, then four facts. The facts are time to first delivery, monthly cost, effort to run and how hard it is to leave the vendors it uses. The full summaries and trade-offs are in `architecture.md`.

- **A letter** picks that option.
- **`revise`** sends your notes to all three proposals and writes them again.
- **`adjust`** rewrites one option. Start the notes with its letter, such as `C: use Postgres row-level security`. Without a letter, it adjusts the recommended option.
- **`discard`** ends the run without writing anything.

The terminal also offers `back` and `pause` at every gate. [The CLI README](../cli/README.md#answering-gates) explains them.

## Output

`flows plan` writes a proposal to `runs/<project>/<run id>/proposed/`. Read it, then copy what you want into the project, or run again with `--write`.

New ADRs follow the [ADR format](../core/README.md#adr-format) with the status `Proposed`. `writeAdrs` asks the model which ADRs in the set relate to each other, and `emit` records each `Related to` link on both ADRs. Accept or change them before you deliver the tasks that link to them.

> **Warning:** `--write` writes straight into the artifacts folder and replaces `docs/prd.md`, `plan/tasks.yaml` and any ADR files with the same names.

## Tests

`test/routing.test.ts` covers the discovery and coverage loops. `test/summaries.test.ts` covers the gate summaries, the scope diff and the `adjust` notes. Run it with `pnpm test` from the engine root.
