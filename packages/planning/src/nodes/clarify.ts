import { logEntry } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { bullets, gate } from "./shared";

/**
 * Human gate. You answer the discovery questions, and your answers go on the
 * end of the brief. "proceed anyway" marks the brief complete.
 *
 * Reads `questions` and `brief`. Writes `brief`, `discoveryRounds` and, on
 * "proceed anyway", `briefComplete`.
 */
export const clarify = async (s: PlanningState): Promise<PlanningUpdate> => {
  const d = gate({
    gate: "clarify",
    title: "The brief has gaps — answer what you can",
    summary: bullets(s.questions),
    options: ["answered", "proceed anyway"],
  });
  const answers = d.notes ?? "(no answers given — make reasonable assumptions and list them)";
  return {
    brief: `${s.brief}\n\n## Answers to discovery questions (round ${s.discoveryRounds + 1})\n${answers}`,
    discoveryRounds: s.discoveryRounds + 1,
    briefComplete: d.decision === "proceed anyway" ? true : undefined,
    log: [logEntry("planning.clarify", { note: d.decision })],
  };
};
