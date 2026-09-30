import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeps, judgeEngine, rolesInUse, withClaudeCodeModels, type ProjectConfig } from "../src";

const cfg = (judge: ProjectConfig["judgeEngine"], provider?: Record<string, unknown>) =>
  ({ judgeEngine: judge, openrouterProvider: provider }) as ProjectConfig;

test("auto uses Jev when a key is set and no provider allow-list restricts the project", () => {
  assert.equal(judgeEngine(cfg("auto", { data_collection: "deny" }), true), "jev");
  assert.equal(judgeEngine(cfg("auto"), false), "llm");
});

test("auto never sends a restricted project's code to Jev, even with a key", () => {
  assert.equal(judgeEngine(cfg("auto", { only: ["anthropic"] }), true), "llm");
});

test("an explicit engine wins over the allow-list", () => {
  assert.equal(judgeEngine(cfg("jev", { only: ["anthropic"] }), true), "jev");
  assert.equal(judgeEngine(cfg("llm"), true), "llm");
});

// ── model routing ───────────────────────────────────────────────────────────

const project = (models: Partial<ProjectConfig["models"]>, extra: Partial<ProjectConfig> = {}) =>
  ({
    project: "p",
    models: { default: "anthropic/claude-sonnet-5.5", reviewer: "openai/gpt-5.5", judge: "openai/gpt-5.4-mini", ...models },
    openrouterProvider: { data_collection: "deny" },
    judgeEngine: "llm",
    ...extra,
  }) as ProjectConfig;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

const noKeys = { OPENROUTER_API_KEY: undefined, TYPESAFE_API_KEY: undefined, FLOWS_OFFLINE: undefined, FLOWS_CLAUDE_CODE: undefined };

test("rolesInUse counts the judge only when the LLM judge answers", () => {
  const cfg = project({});
  assert.deepEqual(rolesInUse(cfg, "llm").map((r) => r.role), ["planner", "reviewer", "judge"]);
  assert.deepEqual(rolesInUse(cfg, "jev").map((r) => r.role), ["planner", "reviewer"]);
});

test("a run with every role on Claude Code needs no OpenRouter key", () => {
  withEnv(noKeys, () => {
    const deps = createDeps(project({ default: "claude-code/sonnet", reviewer: "claude-code/opus", judge: "claude-code/haiku" }));
    assert.deepEqual(deps.backends, ["claude-code"]);
    assert.equal(deps.judge.name, "llm");
  });
});

test("a mixed run names the roles that still need the OpenRouter key", () => {
  withEnv(noKeys, () => {
    assert.throws(() => createDeps(project({ default: "claude-code/sonnet" })), /reviewer \(openai\/gpt-5\.5\), judge/);
  });
  withEnv({ ...noKeys, OPENROUTER_API_KEY: "k" }, () => {
    assert.deepEqual(createDeps(project({ default: "claude-code/sonnet" })).backends, ["openrouter", "claude-code"]);
  });
});

test("--claude-code moves every role to Claude Code but keeps models already set there", () => {
  const cfg = withClaudeCodeModels(project({ reviewer: "claude-code/opus" }));
  assert.equal(cfg.models.planner, "claude-code/default");
  assert.equal(cfg.models.reviewer, "claude-code/opus");
  assert.equal(cfg.models.judge, "claude-code/default");
  withEnv(noKeys, () => assert.deepEqual(createDeps(project({}), { claudeCode: true }).backends, ["claude-code"]));
});

test("Claude Code stays off a project whose provider allow-list leaves Anthropic out", () => {
  withEnv(noKeys, () => {
    const cfg = (only: string[]) => project({}, { openrouterProvider: { only } });
    assert.throws(() => createDeps(cfg(["openai"]), { claudeCode: true }), /openrouter\.provider\.only is \[openai\]/);
    assert.doesNotThrow(() => createDeps(cfg(["anthropic"]), { claudeCode: true }));
  });
});
