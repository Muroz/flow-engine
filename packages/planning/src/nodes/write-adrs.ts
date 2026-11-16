import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { DraftAdr, PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";
import { bullets, reqList } from "./shared";

/**
 * Generative. Short ADRs for the chosen architecture, numbered from
 * ADR-0001, each Decision split into numbered clauses. Links in `related`
 * that aren't ADR ids are dropped.
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
    const { adrs = [] } = parseJsonReply<{ adrs?: (Omit<DraftAdr, "id" | "clauses"> & { clauses?: unknown; decision?: unknown })[] }>(res.text, {});
    // Models sometimes return a single string or junk for "related" and "clauses".
    return {
      adrs: adrs.map(({ decision, ...a }, i) => ({
        ...a,
        id: `ADR-${String(i + 1).padStart(4, "0")}`,
        clauses: asClauses(a.clauses ?? decision),
        related: Array.isArray(a.related) ? a.related.map(String).filter((r) => /^ADR-\d{4}$/.test(r)) : [],
      })),
      log: [logEntry("planning.adrs", { model: res.model, costUsd: res.costUsd, note: `${adrs.length} ADRs` })],
    };
  };

/** Clauses as a list of rules, without any numbering the model added itself. */
export function asClauses(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/\n+/) : [];
  return list.map((c) => c.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
}
