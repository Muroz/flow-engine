import assert from "node:assert/strict";
import { test } from "node:test";
import { jevScoreIndex, SEVERITIES } from "../src";

test("jevScoreIndex takes the most probable level, not the fractional score", () => {
  // A real Jev reply: score 2.2 sits between major and blocker, and major is most likely.
  assert.equal(jevScoreIndex({ score: 2.2, probabilities: { "0": 0, "1": 0, "2": 0.8, "3": 0.2 } }, SEVERITIES), 2);
});

test("jevScoreIndex rounds a bare score, accepts a level name and stays on the scale", () => {
  assert.equal(jevScoreIndex({ score: 2.6 }, SEVERITIES), 3);
  assert.equal(jevScoreIndex({ score: "minor" }, SEVERITIES), 1);
  assert.equal(jevScoreIndex({ score: 7 }, SEVERITIES), 3);
  assert.equal(jevScoreIndex({}, SEVERITIES), 0);
});

test("JevJudge passes a choice's per-option probabilities through, as Jev sent them", async () => {
  const { JevJudge, choice } = await import("../src");
  const real = globalThis.fetch;
  // The answer Jev gave to a live call, trimmed.
  const reply = { answers: { kind: { type: "choice", choice: "missedCriterion", confidence: 0.39, probabilities: { bug: 0.46, missedCriterion: 0.49, brokenRule: 0.05, junk: "x" } } } };
  globalThis.fetch = (async () => new Response(JSON.stringify(reply))) as typeof fetch;
  try {
    const a = await new JevJudge("key").ask({}, { kind: choice("which?", { bug: "", missedCriterion: "", brokenRule: "" }) });
    assert.equal(a.kind.choice, "missedCriterion");
    assert.equal(a.kind.confidence, 0.39);
    assert.deepEqual(a.kind.probabilities, { bug: 0.46, missedCriterion: 0.49, brokenRule: 0.05 });
  } finally {
    globalThis.fetch = real;
  }
});

test("jevProbabilities drops what isn't a number and gives undefined for nothing", async () => {
  const { jevProbabilities } = await import("../src");
  assert.equal(jevProbabilities(undefined), undefined);
  assert.equal(jevProbabilities({ a: "x" }), undefined);
  assert.deepEqual(jevProbabilities({ a: 0.2, b: null }), { a: 0.2 });
});
