import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { ArchFacts, ArchOption, PlanningState, PlanningUpdate } from "../state";
import { mvp } from "../summaries";
import { reqList } from "./shared";

/** Lenses for the architecture fan-out. Diversity comes from the angle — and from using different models per angle if you like. */
export const ARCH_ANGLES = [
  "simplest thing that could work, minimal new infrastructure",
  "built to scale and evolve over 2+ years",
  "buy over build: lean on managed services and existing libraries",
];

/**
 * Generative, and the fan-out target. The graph sends one copy per angle in
 * `ARCH_ANGLES`, and each proposes one architecture for the MVP
 * requirements from that angle. Option ids are A, B and C, in angle order.
 *
 * Reads `currentAngle`, `requirements`, `brief` and `archFeedback`. Writes
 * one entry to `options`, which the reducer merges by id.
 */
export const proposeOption =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.option",
      model: modelFor(deps.config, "planner"), // try a different model per angle for real diversity
      json: true,
      system: "You are a pragmatic software architect.",
      user: render(loadPrompt("planning/option"), {
        angle: s.currentAngle,
        requirements: reqList(mvp(s.requirements)),
        brief: s.brief,
        feedback: s.archFeedback ?? "(none)",
      }),
    });
    const id = String.fromCharCode(65 + ARCH_ANGLES.indexOf(s.currentAngle ?? ""));
    return {
      options: [asOption(parseJsonReply(res.text, {}), id, s.currentAngle ?? "")],
      log: [logEntry(`planning.option.${id}`, { model: res.model, costUsd: res.costUsd })],
    };
  };

/** Fills the fields a model left out, so gates never print "undefined". */
export function asOption(o: Omit<Partial<ArchOption>, "facts"> & { facts?: Partial<ArchFacts> }, id: string, angle: string): ArchOption {
  const f: Partial<ArchFacts> = o.facts ?? {};
  const fact = (x: unknown) => String(x ?? "?");
  return {
    id,
    angle,
    pitch: String(o.pitch ?? o.summary?.split(". ")[0] ?? ""),
    facts: { firstDelivery: fact(f.firstDelivery), monthlyCost: fact(f.monthlyCost), opsBurden: fact(f.opsBurden), lockIn: fact(f.lockIn) },
    summary: String(o.summary ?? ""),
    tradeoffs: Array.isArray(o.tradeoffs) ? o.tradeoffs.map(String) : [],
  };
}
