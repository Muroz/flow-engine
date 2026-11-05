import { logEntry, writeRunFile } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { planDetail, planSummary } from "../summaries";
import { gate } from "./shared";

/**
 * Human gate. Shows the architecture, ADRs, tasks and any coverage gaps,
 * with the full task list in `plan.md` under `detailDir`. approve goes on to
 * `emit`; discard ends the run.
 *
 * Reads `chosen`, `adrs`, `tasks` and `coverage`. Writes `planApproved`.
 */
export const approvePlan =
  (detailDir: string) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const gaps = s.coverage.filter((c) => !c.covered).map((c) => c.requirementId);
    const detailPath = writeRunFile(detailDir, "plan.md", planDetail(s.tasks));
    const d = gate({
      gate: "approve-plan",
      title: `Approve plan: ${s.tasks.length} tasks, ${s.adrs.length} ADRs`,
      summary: planSummary(s.chosen, s.adrs, s.tasks, gaps),
      options: ["approve", "discard"],
      detailPath,
    });
    return { planApproved: d.decision === "approve", log: [logEntry("planning.approvePlan", { note: d.decision })] };
  };
