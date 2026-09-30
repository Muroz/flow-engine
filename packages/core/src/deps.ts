/**
 * Everything a node needs from the outside world, injected once when a graph
 * is built. Nodes never read env vars or construct clients themselves — which
 * is what makes them testable with mocks.
 */
import { modelFor, type ProjectConfig } from "./config";
import { JevJudge, LlmJudge, MockJudge, type Judge } from "./judge";
import { MockModelClient, OpenRouterClient, type ModelClient } from "./models";

export type FlowDeps = {
  config: ProjectConfig;
  model: ModelClient;
  judge: Judge;
  offline: boolean;
};

export function createDeps(config: ProjectConfig, opts: { offline?: boolean } = {}): FlowDeps {
  const offline = opts.offline || process.env.FLOWS_OFFLINE === "1";
  if (offline) {
    return { config, model: new MockModelClient(), judge: new MockJudge(), offline: true };
  }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error("OPENROUTER_API_KEY is not set (or run with --offline).");
  const model = new OpenRouterClient(orKey, config.openrouterProvider);

  const jevKey = process.env.TYPESAFE_API_KEY;
  let judge: Judge;
  if (judgeEngine(config, !!jevKey) === "jev") {
    if (!jevKey) throw new Error("judge.engine is 'jev' but TYPESAFE_API_KEY is not set.");
    judge = new JevJudge(jevKey);
  } else {
    judge = new LlmJudge(model, modelFor(config, "judge"));
  }

  return { config, model, judge, offline: false };
}

/**
 * Which judge a run uses. Jev calls go straight to TypeSafe, not through
 * OpenRouter, so `openrouter.provider` can't restrict them. A project that
 * sets a provider allow-list (`only`) has an AI policy to honour: under
 * "auto" it gets the LLM judge, and Jev only when `judge.engine` says "jev".
 */
export function judgeEngine(config: ProjectConfig, hasJevKey: boolean): "jev" | "llm" {
  if (config.judgeEngine !== "auto") return config.judgeEngine;
  const restricted = Array.isArray(config.openrouterProvider?.only);
  return hasJevKey && !restricted ? "jev" : "llm";
}
