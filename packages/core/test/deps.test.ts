import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeEngine, type ProjectConfig } from "../src";

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
