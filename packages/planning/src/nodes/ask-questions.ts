import { loadPrompt, logEntry, modelFor, parseJsonReply, render, type FlowDeps } from "@flows/core";
import type { PlanningState, PlanningUpdate } from "../state";

/**
 * Generative. Discovery questions for the gaps in the brief. The questions
 * go to the `clarify` gate, which comes next so the model call isn't paid
 * for twice when the graph resumes.
 *
 * Reads `brief`. Writes `questions`.
 */
export const askQuestions =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.questions",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a consultant preparing discovery questions for a client.",
      user: render(loadPrompt("planning/questions"), { brief: s.brief }),
    });
    const { questions = [] } = parseJsonReply<{ questions?: string[] }>(res.text, {});
    return { questions, log: [logEntry("planning.askQuestions", { model: res.model, costUsd: res.costUsd })] };
  };
