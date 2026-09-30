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
