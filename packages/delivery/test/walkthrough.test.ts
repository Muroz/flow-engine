import assert from "node:assert/strict";
import { test } from "node:test";
import { gistOf, howItWorksOf } from "../src/walkthrough";

test("gistOf takes the In short section and stops at the next heading", () => {
  const md = "## In short\nUsers can search orders.\nResults come in pages.\n\n## How it works\nDetails.";
  assert.equal(gistOf(md), "Users can search orders.\nResults come in pages.");
});

test("gistOf falls back to the first paragraph that isn't a heading", () => {
  assert.equal(gistOf("# Title\n\nFirst paragraph.\n\nSecond."), "First paragraph.");
});

test("howItWorksOf takes the How it works section and swaps diagrams for a pointer", () => {
  const md = "## In short\nX.\n\n## How it works\nA calls B.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nB answers.\n\n## What changed\n| File |";
  assert.equal(howItWorksOf(md), "A calls B.\n\n(Diagram in the full text.)\n\nB answers.");
  assert.equal(howItWorksOf("## In short\nX."), undefined);
});
