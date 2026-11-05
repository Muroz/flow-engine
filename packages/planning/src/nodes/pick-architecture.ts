import { logEntry, writeRunFile } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { archDetail, archSummary, parseAdjust } from "../summaries";
import { gate } from "./shared";

/**
 * Human gate. Shows the options with the recommended one first, and the
 * full write-up in `architecture.md` under `detailDir`. Picking an id goes on
 * to the ADRs; revise proposes all options again with your notes; adjust
 * reworks one option; discard ends the run.
 *
 * Reads `options` and `recommendation`. Writes `archDecision`, and `chosen`,
 * `archFeedback` or `adjustTarget` to match.
 */
export const pickArchitecture =
  (detailDir: string) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const rec = s.recommendation?.split(":")[0] ?? "A";
    const ids = s.options.map((o) => o.id);
    const detailPath = writeRunFile(detailDir, "architecture.md", archDetail(s.options, s.recommendation));
    const d = gate({
      gate: "pick-architecture",
      title: "Pick an architecture",
      summary: archSummary(s.options, s.recommendation),
      options: [rec, ...ids.filter((id) => id !== rec), "revise", "adjust", "discard"],
      detailPath,
    });
    const log = [logEntry("planning.pickArchitecture", { note: d.decision })];
    if (d.decision === "revise") return { archDecision: "revise", archFeedback: d.notes, log };
    if (d.decision === "adjust") {
      const { target, notes } = parseAdjust(d.notes ?? "", ids, rec);
      return { archDecision: "adjust", adjustTarget: target, archFeedback: notes, log };
    }
    const chosen = s.options.find((o) => o.id === d.decision);
    return { archDecision: chosen ? "pick" : "discard", chosen, log };
  };
