import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import type { Severity } from "./types";

/**
 * Per-project configuration, read from `.flows.yaml`.
 *
 * It lives next to the project's artifacts: inside the project repo for your
 * own projects, or in a shadow workspace you own for client repos that
 * shouldn't carry your planning files.
 */
export type ProjectConfig = {
  project: string;
  /** Absolute path of the code checkout the flows act on. */
  repoDir: string;
  /** Absolute path where docs/prd.md, docs/adr/, plan/tasks.yaml live. */
  artifactsDir: string;

  models: {
    default: string;
    planner?: string;
    implementer?: string;
    /** Use a different vendor than the implementer so the checker isn't grading its own work. */
    reviewer?: string;
    /** Only used when the judge engine is "llm". */
    judge?: string;
  };

  /**
   * Passed straight to OpenRouter as `provider`. Use it to honour a client's
   * AI policy, e.g. { data_collection: "deny", only: ["anthropic"] }.
   */
  openrouterProvider?: Record<string, unknown>;

  /** "jev" = TypeSafe Jev, "llm" = structured LLM call, "auto" = Jev if a key is set. */
  judgeEngine: "auto" | "jev" | "llm";

  review: {
    reviewers: string[];
    /** Findings the judge is less sure about than this are dropped as noise… */
    minConfidence: number;
    /** …unless they're at least this severe, in which case a human looks. */
    escalateAtSeverity: Severity;
    /** Severities that never reach you, whatever the confidence. */
    dropSeverities: Severity[];
  };

  delivery: {
    /** Stop rule for the implement → check → review loop. */
    maxAttempts: number;
    /** Plans at or below this risk skip the human plan gate. */
    autoApproveRisk: "none" | "low" | "medium";
    /** Shell commands run in the repo after each implementation attempt. */
    checks: string[];
  };

  /** Free-text team conventions handed to reviewers ("we use pnpm", "no default exports"). */
  conventions: string[];
};

const DEFAULTS: Omit<ProjectConfig, "project" | "repoDir" | "artifactsDir"> = {
  // Check https://openrouter.ai/models for current slugs; these are placeholders.
  models: {
    default: "anthropic/claude-sonnet-4.5",
    reviewer: "openai/gpt-5",
    judge: "openai/gpt-5-mini",
  },
  openrouterProvider: { data_collection: "deny" },
  judgeEngine: "auto",
  review: {
    reviewers: ["spec", "correctness", "security", "tests", "architecture"],
    minConfidence: 0.6,
    escalateAtSeverity: "blocker",
    dropSeverities: ["nit"],
  },
  delivery: {
    maxAttempts: 3,
    autoApproveRisk: "low",
    checks: [],
  },
  conventions: [],
};

/**
 * Load `.flows.yaml`.
 *
 * @param repoDir       the code checkout
 * @param artifactsDir  optional shadow workspace; defaults to the repo itself
 */
export function loadConfig(repoDir: string, artifactsDir?: string): ProjectConfig {
  const repo = resolve(repoDir);
  const artifacts = resolve(artifactsDir ?? repo);
  const file = join(artifacts, ".flows.yaml");

  const raw: Record<string, any> = existsSync(file)
    ? (YAML.parse(readFileSync(file, "utf8")) ?? {})
    : {};

  // `artifacts:` inside the file is relative to the file itself.
  const declaredArtifacts =
    typeof raw.artifacts === "string"
      ? isAbsolute(raw.artifacts)
        ? raw.artifacts
        : resolve(dirname(file), raw.artifacts)
      : artifacts;

  return {
    project: raw.project ?? repo.split("/").pop() ?? "project",
    repoDir: repo,
    artifactsDir: declaredArtifacts,
    models: { ...DEFAULTS.models, ...(raw.models ?? {}) },
    openrouterProvider: raw.openrouter?.provider ?? DEFAULTS.openrouterProvider,
    judgeEngine: raw.judge?.engine ?? DEFAULTS.judgeEngine,
    review: { ...DEFAULTS.review, ...(raw.review ?? {}) },
    delivery: { ...DEFAULTS.delivery, ...(raw.delivery ?? {}) },
    conventions: raw.conventions ?? DEFAULTS.conventions,
  };
}

/** The model a given role should use, falling back to the default. */
export function modelFor(config: ProjectConfig, role: keyof ProjectConfig["models"]): string {
  return config.models[role] ?? config.models.default;
}
