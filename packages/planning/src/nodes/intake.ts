import { readFileSync } from "node:fs";
import { logEntry } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";

/**
 * Deterministic. Reads the brief from disk.
 *
 * Reads `briefPath`. Writes `brief`.
 */
export const intake = async (s: PlanningState): Promise<PlanningUpdate> => ({
  brief: readFileSync(s.briefPath, "utf8"),
  log: [logEntry("planning.intake")],
});
