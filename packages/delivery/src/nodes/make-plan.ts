import { adrBrief, loadAdrs, loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { DeliveryState, DeliveryUpdate } from "../state";
import { bullets } from "./shared";

/**
 * Generative. A short implementation plan for the task, rewritten with your
 * notes when you ask for a revision at the plan gate.
 *
 * Reads `task` and the ADRs it cites, and `plan` with `planFeedback` on a revision. Writes `plan`
 * and clears `planFeedback`.
 */
export const makePlan =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const res = await deps.model.complete({
      tag: "delivery.plan",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a senior engineer writing a short implementation plan for one task.",
      user: render(loadPrompt("delivery/plan"), {
        task: `${s.task.id}: ${s.task.title}${s.task.description ? `\n${s.task.description}` : ""}`,
        acceptance_criteria: bullets(s.task.acceptanceCriteria),
        out_of_scope: s.task.outOfScope?.length ? bullets(s.task.outOfScope) : "(none listed)",
        adrs: loadAdrs(deps.config, s.task.adrRefs).map(adrBrief).join("\n\n") || "(none)",
        feedback: s.planFeedback && s.plan ? `${s.plan.summary}\n${bullets(s.plan.steps)}\n\nNotes: ${s.planFeedback}` : "(none)",
      }),
    });
    const p = parseJsonReply<{ summary?: string; steps?: string[] }>(res.text, {});
    return {
      plan: { summary: p.summary ?? "", steps: p.steps ?? [], risk: s.task.risk },
      planFeedback: undefined,
      log: [logEntry("delivery.plan", { model: res.model, costUsd: res.costUsd, note: `${p.steps?.length ?? 0} steps` })],
    };
  };
