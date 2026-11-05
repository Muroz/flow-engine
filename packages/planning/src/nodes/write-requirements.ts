import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { PlanningState, PlanningUpdate, Requirement } from "../state";
import { mvp } from "../summaries";

/** Requirements with priority and area, the form the revise prompt edits. */
const fullReqList = (rs: Requirement[]) =>
  rs.map((r) => `- ${r.id} [${r.priority}] [${r.area}] ${r.title}: ${r.text}`).join("\n");

/**
 * Generative. Testable requirements from the brief, each marked MVP or
 * later. With your notes from the scope gate, it edits the existing list
 * rather than starting over.
 *
 * Reads `brief`, and `requirements` with `scopeFeedback` on a revision.
 * Writes `requirements`, `previousRequirements` and clears `scopeFeedback`.
 */
export const writeRequirements =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    // With feedback on an existing list, edit that list instead of starting over.
    const revising = s.requirements.length > 0 && !!s.scopeFeedback;
    const res = await deps.model.complete({
      tag: revising ? "planning.reviseRequirements" : "planning.requirements",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a product-minded senior engineer writing crisp, testable requirements.",
      user: revising
        ? render(loadPrompt("planning/revise-requirements"), { requirements: fullReqList(s.requirements), feedback: s.scopeFeedback! })
        : render(loadPrompt("planning/requirements"), { brief: s.brief }),
    });
    const { requirements = [] } = parseJsonReply<{ requirements?: Partial<Requirement>[] }>(res.text, {});
    const parsed = requirements.map(asRequirement);
    return {
      requirements: parsed,
      previousRequirements: revising ? s.requirements : [],
      scopeFeedback: undefined,
      log: [
        logEntry(revising ? "planning.reviseRequirements" : "planning.requirements", {
          model: res.model,
          costUsd: res.costUsd,
          note: `${parsed.length} requirements (${mvp(parsed).length} MVP)`,
        }),
      ],
    };
  };

/** Models leave fields out; fill them so gates never print "undefined". */
export function asRequirement(r: Partial<Requirement>, i: number): Requirement {
  const text = String(r.text ?? "");
  return {
    id: String(r.id ?? `R-${i + 1}`),
    title: String(r.title ?? text.split(/[.:]/)[0]!.split(/\s+/).slice(0, 8).join(" ")),
    text,
    area: String(r.area ?? "General"),
    priority: r.priority === "later" ? "later" : "mvp",
  };
}
