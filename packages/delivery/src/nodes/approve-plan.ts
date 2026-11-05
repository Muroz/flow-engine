import { logEntry } from "@flows/core";
import type { DeliveryState, DeliveryUpdate } from "../state";
import { gate } from "./shared";

/**
 * Human gate, open only when the plan's risk is above
 * `delivery.autoApproveRisk`. approve goes on to implement, with your notes
 * for the agent; revise sends your notes back to `makePlan`; reject ends the
 * run.
 *
 * Reads `task` and `plan`. Writes `fixNotes`, `planFeedback` or `outcome`.
 */
export const approvePlan = async (s: DeliveryState): Promise<DeliveryUpdate> => {
  const d = gate({
    gate: "approve-plan",
    title: `Approve plan for ${s.task.id} (${s.plan!.risk} risk)`,
    summary: [
      s.plan!.summary,
      "",
      ...s.plan!.steps.map((step, i) => `${i + 1}. ${step}`),
      "",
      `Acceptance criteria (${s.task.acceptanceCriteria.length}):`,
      ...s.task.acceptanceCriteria.map((c) => `  - ${c}`),
    ].join("\n"),
    options: ["approve", "revise", "reject"],
  });
  const log = [logEntry("delivery.approvePlan", { note: d.decision })];
  if (d.decision === "revise") return { planFeedback: d.notes, log };
  return d.decision === "approve" ? { fixNotes: d.notes ? [d.notes] : [], log } : { outcome: "rejected", log };
};
