import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { DraftAdr, PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";
import { bullets, reqList } from "./shared";

/**
 * Generative. Short ADRs for the chosen architecture, numbered from
 * ADR-0001. Links in `related` that aren't ADR ids are dropped.
 *
 * Reads `chosen` and `requirements`. Writes `adrs`.
 */
export const writeAdrs =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.adrs",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You write short Architecture Decision Records.",
      user: render(loadPrompt("planning/adrs"), {
        chosen: `${s.chosen!.summary}\nTrade-offs:\n${bullets(s.chosen!.tradeoffs)}`,
        requirements: reqList(mvp(s.requirements)),
      }),
    });
    const { adrs = [] } = parseJsonReply<{ adrs?: Omit<DraftAdr, "id">[] }>(res.text, {});
    // Models sometimes return a single string or junk for "related".
    return {
      adrs: adrs.map((a, i) => ({
        ...a,
        id: `ADR-${String(i + 1).padStart(4, "0")}`,
        related: Array.isArray(a.related) ? a.related.map(String).filter((r) => /^ADR-\d{4}$/.test(r)) : [],
      })),
      log: [logEntry("planning.adrs", { model: res.model, costUsd: res.costUsd, note: `${adrs.length} ADRs` })],
    };
  };
