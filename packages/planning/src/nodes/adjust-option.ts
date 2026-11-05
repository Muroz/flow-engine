import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";
import { asOption } from "./propose-option";
import { reqList } from "./shared";

/**
 * Generative. Reworks one option with your notes from the architecture gate,
 * keeping its id and angle, so the other options stay as they were.
 *
 * Reads `adjustTarget`, `options`, `archFeedback` and `requirements`. Writes
 * the reworked entry to `options` and clears `archFeedback`.
 */
export const adjustOption =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const target = s.options.find((o) => o.id === s.adjustTarget) ?? s.options[0]!;
    const res = await deps.model.complete({
      tag: "planning.adjustOption",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a pragmatic software architect.",
      user: render(loadPrompt("planning/adjust-option"), {
        option: JSON.stringify(target, null, 2),
        feedback: s.archFeedback ?? "",
        requirements: reqList(mvp(s.requirements)),
      }),
    });
    return {
      options: [asOption(parseJsonReply(res.text, {}), target.id, target.angle)],
      archFeedback: undefined,
      log: [logEntry(`planning.adjust.${target.id}`, { model: res.model, costUsd: res.costUsd })],
    };
  };
