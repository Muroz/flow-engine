/**
 * Everything a node needs from the outside world, injected once when a graph
 * is built. Nodes never read env vars or construct clients themselves — which
 * is what makes them testable with mocks.
 */
import { modelFor, type ProjectConfig } from "./config";
import { JevJudge, LlmJudge, MockJudge, type Judge } from "./judge";
import {
  CLAUDE_CODE_PREFIX,
  ClaudeCodeClient,
  isClaudeCodeModel,
  MockModelClient,
  OpenRouterClient,
  RoutingModelClient,
  type ModelClient,
} from "./models";

export type FlowDeps = {
  config: ProjectConfig;
  model: ModelClient;
  judge: Judge;
  offline: boolean;
  /** Which model backends this run calls, for the CLI's first line. */
  backends: ("openrouter" | "claude-code")[];
};

export type DepsOptions = {
  offline?: boolean;
  /** Route every model role to local Claude Code. Same as FLOWS_CLAUDE_CODE=1. */
  claudeCode?: boolean;
};

export function createDeps(baseConfig: ProjectConfig, opts: DepsOptions = {}): FlowDeps {
  const offline = opts.offline || process.env.FLOWS_OFFLINE === "1";
  const claudeCode = opts.claudeCode || process.env.FLOWS_CLAUDE_CODE === "1";
  const config = claudeCode ? withClaudeCodeModels(baseConfig) : baseConfig;
  if (offline) {
    return { config, model: new MockModelClient(), judge: new MockJudge(), offline: true, backends: [] };
  }

  const jevKey = process.env.TYPESAFE_API_KEY;
  const engine = judgeEngine(config, !!jevKey);
  if (engine === "jev" && !jevKey) throw new Error("judge.engine is 'jev' but TYPESAFE_API_KEY is not set.");

  const roles = rolesInUse(config, engine);
  const viaOpenRouter = roles.filter((r) => !isClaudeCodeModel(r.model));
  const viaClaudeCode = roles.filter((r) => isClaudeCodeModel(r.model));

  const orKey = process.env.OPENROUTER_API_KEY;
  if (viaOpenRouter.length && !orKey) {
    throw new Error(
      `OPENROUTER_API_KEY is not set, and these roles use OpenRouter: ${describe(viaOpenRouter)}. ` +
        `Set the key, route them to ${CLAUDE_CODE_PREFIX}<model>, pass --claude-code or run with --offline.`,
    );
  }
  if (viaClaudeCode.length) assertClaudeCodeAllowed(config, viaClaudeCode);

  const model = new RoutingModelClient({
    openrouter: orKey ? new OpenRouterClient(orKey, config.openrouterProvider) : undefined,
    claudeCode: viaClaudeCode.length || claudeCode ? new ClaudeCodeClient() : undefined,
  });
  const judge: Judge = engine === "jev" ? new JevJudge(jevKey!) : new LlmJudge(model, modelFor(config, "judge"));
  const backends: FlowDeps["backends"] = [];
  if (viaOpenRouter.length) backends.push("openrouter");
  if (viaClaudeCode.length) backends.push("claude-code");

  return { config, model, judge, offline: false, backends };
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

type RoleModel = { role: keyof ProjectConfig["models"]; model: string };

/**
 * The model roles a run calls through `ModelClient`. The judge only counts
 * when the LLM judge answers. `implementer` never does: only the Claude Code
 * agent reads it, and that agent runs on its own.
 */
export function rolesInUse(config: ProjectConfig, engine: "jev" | "llm"): RoleModel[] {
  const roles: RoleModel["role"][] = ["planner", "reviewer", "verifier", ...(engine === "llm" ? (["judge"] as const) : [])];
  return roles.map((role) => ({ role, model: modelFor(config, role) }));
}

/** Every role on local Claude Code, on `claudeCode.model` unless a role already names a Claude Code model. */
export function withClaudeCodeModels(config: ProjectConfig): ProjectConfig {
  const keep = (m: string | undefined) => (m && isClaudeCodeModel(m) ? m : `${CLAUDE_CODE_PREFIX}${config.claudeCodeModel ?? "default"}`);
  return {
    ...config,
    models: {
      default: keep(config.models.default),
      planner: keep(config.models.planner ?? config.models.default),
      implementer: keep(config.models.implementer ?? config.models.default),
      reviewer: keep(config.models.reviewer ?? config.models.default),
      judge: keep(config.models.judge ?? config.models.default),
      verifier: keep(config.models.verifier ?? config.models.judge ?? config.models.default),
    },
  };
}

/**
 * Claude Code sends prompts straight to Anthropic, outside OpenRouter, so
 * `openrouter.provider` can't route it. A project whose allow-list leaves
 * Anthropic out has an AI policy that rules it out.
 */
export function assertClaudeCodeAllowed(config: ProjectConfig, roles: RoleModel[]): void {
  const only = config.openrouterProvider?.only;
  if (Array.isArray(only) && !only.includes("anthropic")) {
    throw new Error(
      `${describe(roles)} use Claude Code, which sends code to Anthropic, but openrouter.provider.only is [${only.join(", ")}].`,
    );
  }
}

const describe = (roles: RoleModel[]) => roles.map((r) => `${r.role} (${r.model})`).join(", ");
