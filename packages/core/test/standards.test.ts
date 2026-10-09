import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStandards, parseStandards, writingRules, type ProjectConfig } from "../src";

test("parseStandards reads full entries and treats a plain path as an architecture standard", () => {
  assert.deepEqual(parseStandards(["docs/standards/modules.md", { path: "docs/standards/testing.md", reviewers: ["tests"] }, 42]), [
    { path: "docs/standards/modules.md", reviewers: ["architecture"] },
    { path: "docs/standards/testing.md", reviewers: ["tests"] },
  ]);
  assert.deepEqual(parseStandards(undefined), []);
});

test("loadStandards reads each file and skips a missing one", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flows-standards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs/testing.md"), "One test per criterion.");
  const config = {
    artifactsDir: dir,
    standards: [
      { path: "docs/testing.md", reviewers: ["tests"] },
      { path: "docs/missing.md", reviewers: ["docs"] },
    ],
  } as ProjectConfig;
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(loadStandards(config), [{ path: "docs/testing.md", reviewers: ["tests"], text: "One test per criterion." }]);
  assert.equal(warn.mock.callCount(), 1);
});

test("writingRules names the audience", () => {
  assert.match(writingRules("owner"), /AUDIENCE: The project owner/);
  assert.match(writingRules("developer"), /AUDIENCE: A developer who knows the stack/);
  assert.ok(!writingRules("developer").includes("{{audience}}"));
});
