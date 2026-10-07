import assert from "node:assert/strict";
import { test } from "node:test";
import { gistOf } from "../src/walkthrough";

test("gistOf takes the In short section and stops at the next heading", () => {
  const md = "## In short\nUsers can search orders.\nResults come in pages.\n\n## How it works\nDetails.";
  assert.equal(gistOf(md), "Users can search orders.\nResults come in pages.");
});

test("gistOf falls back to the first paragraph that isn't a heading", () => {
  assert.equal(gistOf("# Title\n\nFirst paragraph.\n\nSecond."), "First paragraph.");
});
