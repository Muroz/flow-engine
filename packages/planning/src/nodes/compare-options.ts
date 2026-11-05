import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";
import { bullets, reqList } from "./shared";

/**
 * Generative. A second model, the reviewer role, compares the options
 * against the MVP requirements and recommends one.
 *
 * Reads `options` and `requirements`. Writes `recommendation`, as
 * "<id>: <why>".
 */
export const compareOptions =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.compare",
      model: modelFor(deps.config, "reviewer"), // a different model judges the options
      json: true,
      system: "You are a principal engineer choosing between architecture options for a small team.",
      user: render(loadPrompt("planning/compare"), {
        requirements: reqList(mvp(s.requirements)),
        options: s.options
          .map((o) => `### Option ${o.id} (${o.angle})\n${o.pitch}\n${o.summary}\nFacts: ${JSON.stringify(o.facts)}\nTrade-offs:\n${bullets(o.tradeoffs)}`)
          .join("\n\n"),
      }),
    });
    const { recommended = "A", why = "" } = parseJsonReply<{ recommended?: string; why?: string }>(res.text, {});
    return { recommendation: `${recommended}: ${why}`, log: [logEntry("planning.compare", { model: res.model, costUsd: res.costUsd, note: `recommends ${recommended}` })] };
  };
