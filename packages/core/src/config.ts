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
    /** Files left out of every review and walkthrough. Added to DEFAULT_REVIEW_IGNORE. */
    ignore: string[];
  };

  delivery: {
    /** Stop rule for the implement → check → review loop. */
    maxAttempts: number;
    /** Plans at or below this risk skip the human plan gate. */
    autoApproveRisk: "none" | "low" | "medium";
    /** Shell commands run after each implementation attempt, in the agent's worktree when there is one. */
    checks: string[];
    /**
     * Who writes the code. "diff-file" replays the diff from --diff-file (or
     * --base...--head) on every attempt, for demos and tests. "claude-code"
     * runs Claude Code headless in a git worktree per task.
     */
    agent: "diff-file" | "claude-code";
    /** Claude Code tool allow-list. Defaults to read/edit tools plus one Bash rule per check. */
    agentTools?: string[];
    /** Files git doesn't track, such as .env, copied from the repo into the agent's worktree when it lacks them. */
    copyToWorktree: string[];
    /** Model spend in US dollars after which a run stops and asks you. 0 turns the limit off. */
    maxCostUsd: number;
    /** Extra attempts a "retry" at the escalate gate or a "fix" at the merge gate grants. */
    retryAttempts: number;
  };

  /** The model for local Claude Code when a role doesn't name one: an alias such as "opus", or a full model name. */
  claudeCodeModel: string;

  /** Free-text team conventions handed to reviewers ("we use pnpm", "no default exports"). */
  conventions: string[];

  /** Project standards files. The coding agent reads them all; each reviewer gets the ones listed for it. */
  standards: StandardRef[];
};

export type StandardRef = {
  /** Relative to the artifacts folder, such as docs/standards/testing.md. */
  path: string;
  /** Reviewer IDs that check against this file. */
  reviewers: string[];
};

/** A plain path is shorthand for a standard only the architecture reviewer checks. */
export function parseStandards(raw: unknown): StandardRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): StandardRef[] => {
    if (typeof entry === "string") return [{ path: entry, reviewers: ["architecture"] }];
    if (entry && typeof entry.path === "string") {
      const reviewers = Array.isArray(entry.reviewers) ? entry.reviewers.map(String) : ["architecture"];
      return [{ path: entry.path, reviewers }];
    }
    return [];
  });
}

const DEFAULTS: Omit<ProjectConfig, "project" | "repoDir" | "artifactsDir"> = {
  // Slugs from https://openrouter.ai/models. Keep the reviewer on a different vendor from the implementer.
  models: {
    default: "anthropic/claude-sonnet-5.5",
    reviewer: "openai/gpt-5.5",
    judge: "openai/gpt-5.4-mini",
  },
  openrouterProvider: { data_collection: "deny" },
  judgeEngine: "auto",
  review: {
    reviewers: ["spec", "correctness", "security", "tests", "architecture", "docs"],
    minConfidence: 0.6,
    escalateAtSeverity: "blocker",
    dropSeverities: ["nit"],
    ignore: [],
  },
  delivery: {
    maxAttempts: 3,
    autoApproveRisk: "low",
    checks: [],
    agent: "diff-file",
    maxCostUsd: 5,
    retryAttempts: 1,
    copyToWorktree: [],
  },
  claudeCodeModel: "opus",
  conventions: [],
  standards: [],
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
    standards: parseStandards(raw.standards),
    claudeCodeModel: raw.claudeCode?.model ?? DEFAULTS.claudeCodeModel,
  };
}

/** Generated files: they make reviews expensive and no reviewer can judge them. */
export const DEFAULT_REVIEW_IGNORE = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.snap",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
];

export const reviewIgnore = (config: ProjectConfig) => [...DEFAULT_REVIEW_IGNORE, ...config.review.ignore];

/** The model a given role should use, falling back to the default. */
export function modelFor(config: ProjectConfig, role: keyof ProjectConfig["models"]): string {
  return config.models[role] ?? config.models.default;
}
