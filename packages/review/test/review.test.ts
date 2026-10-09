/**
 * Nodes are plain functions, so most of the flow is testable without a graph.
 * Run with `pnpm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding, TriagedFinding } from "@flows/core";
import { decideVerdict, dedupeFindings, fileDiff } from "../src/nodes";
import { activeReviewers } from "../src/reviewers";

const f = (over: Partial<Finding>): Finding => ({
  reviewer: "security",
  title: "SQL built with string interpolation",
  file: "src/a.ts",
  line: 10,
  severity: "major",
  rationale: "",
  ...over,
});

const t = (over: Partial<TriagedFinding>): TriagedFinding => ({
  ...f({}),
  judgedSeverity: "major",
  confidence: 0.9,
  kept: true,
  ...over,
});

const policy = { minConfidence: 0.6, escalateAtSeverity: "blocker" as const };

test("dedupe merges the same issue from two reviewers and keeps the higher severity", () => {
  const merged = dedupeFindings([
    f({ reviewer: "security", severity: "major" }),
    f({ reviewer: "correctness", line: 12, severity: "blocker", title: "String interpolation in SQL query" }),
    f({ reviewer: "tests", file: "src/b.ts", title: "No tests" }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.severity, "blocker");
  assert.deepEqual(merged[0]!.alsoRaisedBy, ["correctness"]);
});

test("dedupe keeps findings far apart in the same file separate", () => {
  const merged = dedupeFindings([f({ line: 10 }), f({ line: 80, reviewer: "correctness" })]);
  assert.equal(merged.length, 2);
});

test("verdict: confident major → fix", () => {
  assert.equal(decideVerdict([t({})], policy).verdict, "fix");
});

test("verdict: uncertain blocker → escalate, even alongside confident findings", () => {
  const v = decideVerdict([t({}), t({ judgedSeverity: "blocker", confidence: 0.4, kept: false })], policy);
  assert.equal(v.verdict, "escalate");
});

test("verdict: only minors → pass", () => {
  assert.equal(decideVerdict([t({ judgedSeverity: "minor" })], policy).verdict, "pass");
});

test("verdict: dropped findings don't block", () => {
  assert.equal(decideVerdict([t({ kept: false, confidence: 0.3 })], policy).verdict, "pass");
});

test("spec reviewer only runs when there's a task with criteria", () => {
  const ctx = { diff: "", files: [], skipped: [], standards: [], adrs: [], conventions: [] };
  const ids = ["spec", "security", "architecture"];
  assert.deepEqual(activeReviewers(ids, ctx).map((r) => r.id), ["security"]);
  const withTask = {
    ...ctx,
    task: { id: "T-1", title: "x", requirementIds: [], adrRefs: [], dependsOn: [], acceptanceCriteria: ["a"], risk: "low" as const },
  };
  assert.deepEqual(activeReviewers(ids, withTask).map((r) => r.id), ["spec", "security"]);
});

test("fileDiff returns only the requested file's section", () => {
  const diff = "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\ndiff --git a/y.ts b/y.ts\n+++ b/y.ts\n+y\n";
  assert.ok(fileDiff(diff, "y.ts").includes("+y"));
  assert.ok(!fileDiff(diff, "y.ts").includes("+x"));
});

test("docs reviewer runs only when the diff touches docs or adds comments", () => {
  const ctx = (files: string[], diff: string) => ({ diff, files, skipped: [], standards: [], adrs: [], conventions: [] });
  const ids = (c: ReturnType<typeof ctx>) => activeReviewers(["docs"], c).map((r) => r.id);
  assert.deepEqual(ids(ctx(["README.md"], "+Some text")), ["docs"]);
  assert.deepEqual(ids(ctx(["src/a.ts"], "+++ b/src/a.ts\n+  // explain the retry limit\n+const x = 1;")), ["docs"]);
  assert.deepEqual(ids(ctx(["src/a.ts"], "+++ b/src/a.ts\n+const x = 1;")), []);
  assert.deepEqual(ids(ctx(["bin/run"], "+++ b/bin/run\n+#!/usr/bin/env node")), []);
});

test("loadContext leaves generated files out but tells reviewers they changed", async () => {
  const { loadContext } = await import("../src/nodes");
  const diff = "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n+lots\ndiff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+const a = 1;\n";
  const deps = { config: { review: { ignore: [] }, conventions: [], standards: [], artifactsDir: "/nowhere" } } as any;
  const out = await loadContext(deps)({ input: { diff, label: "t" } } as any);
  assert.deepEqual(out.context!.skipped, ["pnpm-lock.yaml"]);
  assert.deepEqual(out.context!.files, ["src/a.ts"]);
  assert.match(out.context!.diff, /^Generated files this change also adds or edits.*pnpm-lock\.yaml/);
  assert.ok(!out.context!.diff.includes("+lots"));
});

test("each reviewer gets only the standards listed for it", async () => {
  const { standardsFor } = await import("../src/reviewers");
  const ctx = {
    diff: "",
    files: [],
    skipped: [],
    adrs: [],
    conventions: [],
    standards: [
      { path: "docs/standards/modules.md", reviewers: ["architecture", "correctness"], text: "Services check permissions." },
      { path: "docs/standards/testing.md", reviewers: ["tests"], text: "One test per criterion." },
    ],
  };
  assert.match(standardsFor("architecture", ctx), /modules\.md[\s\S]*Services check permissions/);
  assert.ok(!standardsFor("architecture", ctx).includes("testing.md"));
  assert.match(standardsFor("tests", ctx), /One test per criterion/);
  assert.equal(standardsFor("security", ctx), "(none)");
});

test("docs findings never rise above minor, whatever the judge says", async () => {
  const { capSeverity } = await import("../src/nodes");
  assert.equal(capSeverity("docs", "major"), "minor");
  assert.equal(capSeverity("docs", "nit"), "nit");
  assert.equal(capSeverity("security", "blocker"), "blocker");
});
