import assert from "node:assert/strict";
import { test } from "node:test";
import { choose, type Prompter } from "../src/drive";

function scripted(...answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(q) {
      asked.push(q);
      if (!answers.length) throw new Error(`ran out of answers at: ${q}`);
      return answers.shift()!;
    },
    close() {},
  };
}

const choices = ["approve", "revise", "discard", "back", "pause"];
const quiet = () => {};

test("an empty line is never an answer", async () => {
  assert.deepEqual(await choose(choices, scripted("", "approve", ""), quiet), { decision: "approve", notes: undefined });
});

test("a number picks the choice in that position", async () => {
  assert.deepEqual(await choose(choices, scripted("4"), quiet), { decision: "back" });
});

test("discard asks for confirmation, and anything but yes asks again", async () => {
  assert.deepEqual(await choose(choices, scripted("discard", "", "1", "looks good"), quiet), { decision: "approve", notes: "looks good" });
  assert.deepEqual(await choose(choices, scripted("discard", "y", ""), quiet), { decision: "discard", notes: undefined });
});

test("revise insists on notes", async () => {
  const p = scripted("revise", "", "R-12 later");
  assert.deepEqual(await choose(choices, p, quiet), { decision: "revise", notes: "R-12 later" });
  assert.match(p.asked.at(-1)!, /needs notes/);
});
