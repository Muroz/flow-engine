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
  const ctx = { diff: "", files: [], adrs: [], conventions: [] };
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
