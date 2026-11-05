import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendTriageGaps,
  CATEGORY_WARN_AT,
  categoryWarnings,
  DEFAULT_CATEGORIES,
  ENGINE_ROOT,
  parseCategories,
} from "../src/index";

test("no review.categories gives the built-in table", () => {
  assert.deepEqual(parseCategories(undefined), DEFAULT_CATEGORIES);
});

test("a project changes a built-in severity and adds its own kind", () => {
  const table = parseCategories({ missingTests: "minor", pii: { description: "personal data logged", severity: "blocker" } });
  assert.equal(table.missingTests!.severity, "minor");
  assert.equal(table.missingTests!.description, DEFAULT_CATEGORIES.missingTests!.description);
  assert.deepEqual(table.pii, { description: "personal data logged", severity: "blocker" });
  assert.equal(DEFAULT_CATEGORIES.missingTests!.severity, "major", "the defaults stay untouched");
});

test("bad entries fail together, each with its reason", () => {
  assert.throws(
    () =>
      parseCategories({
        other: "minor",
        pii: "blocker",
        bug: "critical",
        slowQuery: { severity: "major" },
        leak: { description: "x", severity: "high" },
        "bad name": "minor",
      }),
    (e: Error) =>
      /"other" is reserved/.test(e.message) &&
      /pii.*isn't a built-in kind/.test(e.message) &&
      /"critical" isn't a severity/.test(e.message) &&
      /slowQuery: needs a description/.test(e.message) &&
      /leak: needs a severity/.test(e.message) &&
      /bad name: a kind's name/.test(e.message),
  );
});

test("a table longer than CATEGORY_WARN_AT warns, and the built-in one doesn't", () => {
  assert.deepEqual(categoryWarnings(DEFAULT_CATEGORIES), []);
  const extra = Object.fromEntries(
    Array.from({ length: CATEGORY_WARN_AT + 1 - Object.keys(DEFAULT_CATEGORIES).length }, (_, i) => [`kind${i}`, { description: "d", severity: "minor" }]),
  );
  const [warning] = categoryWarnings(parseCategories(extra));
  assert.match(warning!, new RegExp(`${CATEGORY_WARN_AT + 1} kinds, more than ${CATEGORY_WARN_AT}`));
});

test("gaps go to runs/<project>/triage-gaps.md, one line each, with a header the first time", () => {
  const project = `test-gaps-${process.pid}`;
  const dir = join(ENGINE_ROOT, "runs", project);
  try {
    const gap = { title: "Log the request id", reviewer: "correctness", rationale: "Hard to trace. More words.", category: "other", confidence: 0.4, severity: "minor" as const };
    const path = appendTriageGaps(project, "T-1", [gap]);
    appendTriageGaps(project, "T-2", [{ ...gap, title: "Second", category: "security", alternatives: ["bug 0.35"] }]);
    const text = readFileSync(path, "utf8");
    assert.equal(text.match(/^# /gm)!.length, 1);
    assert.match(text, /T-1 · "Log the request id" from correctness: judge said other \(confidence 0\.40\), kept as minor\. Hard to trace\.$/m);
    assert.match(text, /T-2 · "Second" from correctness: judge said security \(confidence 0\.40; also bug 0\.35\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
});
