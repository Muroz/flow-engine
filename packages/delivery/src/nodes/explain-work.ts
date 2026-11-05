import type { FlowDeps } from "@flows/core";
import type { DeliveryState, DeliveryUpdate } from "../state";
import { writeWalkthrough } from "../walkthrough";

/**
 * Generative. A plain-language walkthrough of the change, written to the run
 * folder, for you to read before the merge gate.
 *
 * Reads `task`, `diff`, `plan` and `review`. Writes `walkthrough`.
 */
export const explainWork =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const { walkthrough, log } = await writeWalkthrough(deps, {
      task: s.task,
      diff: s.diff ?? "",
      runId: s.runId,
      plan: s.plan,
      review: s.review,
    });
    return { walkthrough, log: [log] };
  };
