import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps, type PlannedTask } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";
import { reqList } from "./shared";

/**
 * Generative. Breaks the MVP into small tasks with dependencies and
 * acceptance criteria. On a second round it gets its earlier list and the
 * requirements `checkCoverage` found uncovered.
 *
 * Reads `requirements`, `adrs`, `tasks` and `coverage`. Writes `tasks` and
 * `breakdownRounds`.
 */
export const breakdown =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const gaps = s.coverage.filter((c) => !c.covered).map((c) => c.requirementId);
    const res = await deps.model.complete({
      tag: "planning.breakdown",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You break projects into small, independently reviewable tasks with explicit dependencies.",
      user: render(loadPrompt("planning/breakdown"), {
        requirements: reqList(mvp(s.requirements)),
        adrs: s.adrs.map((a) => `${a.id}: ${a.title} — ${a.decision}`).join("\n"),
        previous: s.tasks.length ? JSON.stringify(s.tasks) : "(none)",
        gaps: gaps.length ? `GAPS — these requirements are not covered yet: ${gaps.join(", ")}` : "",
      }),
    });
    const { tasks = [] } = parseJsonReply<{ tasks?: PlannedTask[] }>(res.text, {});
    return {
      tasks,
      breakdownRounds: s.breakdownRounds + 1,
      log: [logEntry("planning.breakdown", { model: res.model, costUsd: res.costUsd, note: `${tasks.length} tasks` })],
    };
  };
