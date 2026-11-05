import { logEntry, noul, type FlowDeps } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";

/**
 * Judge, then deterministic. One Jev call, many questions: "is R-1
 * covered?", "is R-2 covered?", … all answered in a single pass over the same
 * state (the task list). A requirement counts as covered at p >= 0.6. Then
 * plain code finds tasks that trace back to no MVP requirement.
 *
 * Reads `requirements` and `tasks`. Writes `coverage`.
 */
export const checkCoverage =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const scope = mvp(s.requirements);
    const questions = Object.fromEntries(
      scope.map((r) => [
        r.id.replace(/\W/g, "_"),
        noul(`Is requirement ${r.id} ("${r.text}") fully delivered by these tasks' acceptance criteria?`),
      ]),
    );
    const answers = await deps.judge.ask({ tasks: s.tasks.map(({ id, title, requirementIds, acceptanceCriteria }) => ({ id, title, requirementIds, acceptanceCriteria })) }, questions);

    // Deterministic half: every task must trace back to a real requirement.
    const known = new Set(scope.map((r) => r.id));
    const orphans = s.tasks.filter((t) => !t.requirementIds.some((id) => known.has(id))).map((t) => t.id);

    const coverage = scope.map((r) => {
      const p = (answers as Record<string, { p: number }>)[r.id.replace(/\W/g, "_")]?.p ?? 0;
      return { requirementId: r.id, p, covered: p >= 0.6 };
    });
    const gaps = coverage.filter((c) => !c.covered).map((c) => c.requirementId);
    return {
      coverage,
      log: [logEntry("planning.coverage", { note: `${deps.judge.name}: gaps [${gaps.join(", ")}], orphan tasks [${orphans.join(", ")}]` })],
    };
  };
