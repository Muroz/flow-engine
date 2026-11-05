import { logEntry, noul, type FlowDeps } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";

/**
 * Judge. Is the brief complete enough to write requirements from? It should
 * name the users, the core flows, the constraints and what success looks
 * like.
 *
 * Reads `brief`. Writes `briefComplete`.
 */
export const assessBrief =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const a = await deps.judge.ask(
      { brief: s.brief },
      {
        complete: noul(
          "Is this brief complete enough to write requirements? It should name the users, the core flows, constraints (stack, budget, deadlines) and what success looks like.",
        ),
      },
    );
    return {
      briefComplete: a.complete.p >= 0.7,
      log: [logEntry("planning.assessBrief", { note: `${deps.judge.name}: complete p=${a.complete.p.toFixed(2)}` })],
    };
  };
