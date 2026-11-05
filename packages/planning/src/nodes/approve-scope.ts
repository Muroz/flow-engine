import { logEntry, writeRunFile } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { mvp, scopeDetail, scopeSummary } from "../summaries";
import { gate } from "./shared";

/**
 * Human gate. Shows the requirements, and what changed since the last
 * round, with the full list in `scope.md` under `detailDir`. approve goes on
 * to the architecture, revise sends your notes back to `writeRequirements`
 * and discard ends the run.
 *
 * Reads `requirements` and `previousRequirements`. Writes `scopeDecision`
 * and `scopeFeedback`.
 */
export const approveScope =
  (detailDir: string) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const detailPath = writeRunFile(detailDir, "scope.md", scopeDetail(s.requirements));
    const d = gate({
      gate: "approve-scope",
      title: `Approve scope: ${mvp(s.requirements).length} MVP requirements, ${s.requirements.length - mvp(s.requirements).length} later`,
      summary: scopeSummary(s.requirements, s.previousRequirements),
      options: ["approve", "revise", "discard"],
      detailPath,
    });
    return {
      scopeDecision: d.decision as PlanningState["scopeDecision"],
      scopeFeedback: d.decision === "revise" ? d.notes : undefined,
      log: [logEntry("planning.approveScope", { note: d.decision })],
    };
  };
