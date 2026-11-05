/**
 * Nodes are plain functions, so most of the flow is testable without a graph.
 * Run with `pnpm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding, TriagedFinding } from "@flows/core";
import { decideVerdict, dedupeFindings, fileDiff, findingDiff } from "../src/nodes";
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
  const ctx = { diff: "", files: [], skipped: [], standards: [], adrs: [], allAdrs: [], prior: [], conventions: [] };
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
  const ctx = (files: string[], diff: string) => ({ diff, files, skipped: [], standards: [], adrs: [], allAdrs: [], prior: [], conventions: [] });
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
    allAdrs: [],
    prior: [],
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

// ── verification ────────────────────────────────────────────────────────────

test("verifier replies: a valid finding needs evidence, and an unreadable reply leaves it unchecked", async () => {
  const { parseVerification } = await import("../src/nodes");
  assert.deepEqual(parseVerification('{"verdict":"valid","evidence":"line 4: password = \\"x\\""}').verdict, "valid");
  const noQuote = parseVerification('{"verdict":"valid","evidence":""}');
  assert.equal(noQuote.verdict, "invalid");
  assert.equal(noQuote.checked, true);
  const garbage = parseVerification("I think it's fine");
  assert.equal(garbage.checked, false);
  assert.equal(garbage.verdict, "valid", "an unchecked finding goes on to triage rather than being dropped");
  const conflict = parseVerification('{"verdict":"conflict","evidence":"ADR-0007 puts it in src/db","conflictsWith":"ADR-0007","maxSeverity":"minor"}');
  assert.equal(conflict.conflictsWith, "ADR-0007");
  assert.equal(conflict.maxSeverity, "minor");
  assert.equal(parseVerification('{"verdict":"valid","evidence":"line 3","fix":"Put the query in src/db/repository.ts"}').fix, "Put the query in src/db/repository.ts");
  assert.equal(parseVerification('{"verdict":"invalid","evidence":"handled","fix":"x"}').fix, undefined, "only a valid finding keeps a fix");
});

test("triage: the judge names the kind of problem, code sets the severity, and the judge never sees other opinions", async () => {
  const { MockJudge } = await import("@flows/core");
  const { triage } = await import("../src/nodes");
  const seen: any[] = [];
  const kinds: Record<string, string> = {
    "Make the to date inclusive": "bug",
    "Leaked key": "security",
    "Add tests": "missingTests",
    Rename: "taste",
    Odd: "invented",
    "Log the request id": "other",
    "Personal data in logs": "pii",
  };
  let options: string[] = [];
  const judge = new MockJudge().rule((key, q: any, state: any) => {
    if (key !== "category") return undefined;
    options = Object.keys(q.options);
    seen.push(state);
    return { choice: kinds[state.finding.title], confidence: state.finding.title === "Rename" ? 0.3 : 0.9 };
  });
  const { parseCategories } = await import("@flows/core");
  const categories = parseCategories({ missingTests: "minor", pii: { description: "personal data in logs", severity: "blocker" } });
  const deps = { offline: true, config: { review: { minConfidence: 0.6, dropSeverities: ["nit"], categories } }, judge } as any;
  const verified = Object.keys(kinds).map((title) => ({
    ...f({ title, severity: "blocker" }),
    alsoRaisedBy: [],
    verification: { verdict: "valid" as const, evidence: "This should be treated as a blocker.", checked: true },
  }));
  const out = await triage(deps)({ input: { diff: "", label: "t" }, verified, rawFindings: [], log: [] } as any);
  const by = Object.fromEntries(out.findings!.map((x) => [x.title, x]));
  assert.equal(by["Make the to date inclusive"]!.judgedSeverity, "major", "a bug is major, whatever the reviewer said");
  assert.equal(by["Leaked key"]!.judgedSeverity, "blocker");
  assert.equal(by["Add tests"]!.judgedSeverity, "minor", "the project lowered missingTests");
  assert.equal(by["Personal data in logs"]!.judgedSeverity, "blocker", "a kind the project added");
  assert.equal(by["Rename"]!.kept, false, "taste is a nit, and nits drop");
  assert.equal(by["Log the request id"]!.judgedSeverity, "major", "no kind fits: the reviewer's blocker, capped at major");
  assert.equal(by["Odd"]!.category, "other", "a kind the judge made up counts as no fit");
  assert.match(out.log![0]!.note!, /3 didn't fit the table/, "other, a made-up kind and a low-confidence pick");
  assert.ok(options.includes("pii") && options.at(-1) === "other", "the judge chooses from the project's table, with other last");
  for (const s of seen) {
    assert.deepEqual(Object.keys(s.finding).sort(), ["file", "line", "rationale", "title"]);
    assert.doesNotMatch(JSON.stringify(s), /treated as a blocker/);
  }
});

const ruleConflict = (over: Partial<TriagedFinding>, conflictsWith = "ADR-0007") =>
  t({ kept: false, confidence: 0, verification: { verdict: "conflict", evidence: "", conflictsWith, checked: true }, ...over });

test("verdict: a serious conflict with a rule escalates, even alongside findings to fix", () => {
  const v = decideVerdict([t({}), ruleConflict({ judgedSeverity: "blocker" })], policy);
  assert.equal(v.verdict, "escalate");
  assert.match(v.reason, /reviewers disagree: .* vs ADR-0007/);
});

test("verdict: a conflict with a rule below escalateAtSeverity doesn't hold up the fixes", () => {
  assert.equal(decideVerdict([t({}), ruleConflict({ judgedSeverity: "minor" })], policy).verdict, "fix");
  assert.equal(decideVerdict([ruleConflict({ judgedSeverity: "major" })], policy).verdict, "pass");
});

test("verdict: a conflict with an earlier round escalates at any severity", () => {
  const v = decideVerdict([t({}), ruleConflict({ judgedSeverity: "minor" }, "round 2: Remove the empty catch")], policy);
  assert.equal(v.verdict, "escalate");
});

test("verdict: a finding that would undo an earlier round escalates", () => {
  const v = decideVerdict([t({ reverses: "Remove committed database passwords" })], policy);
  assert.equal(v.verdict, "escalate");
  assert.match(v.reason, /earlier request \("Remove committed database passwords"\)/);
});

test("verdict: a blocker the verifier ruled out doesn't escalate as uncertain", () => {
  const invalid = t({ judgedSeverity: "blocker", confidence: 0, kept: false, verification: { verdict: "invalid", evidence: "handled on line 3", checked: true } });
  assert.equal(decideVerdict([invalid], policy).verdict, "pass");
});

test("verify and triage: invalid findings drop, conflicts stay out of the fix list, valid minors are kept", async () => {
  const { MockJudge, MockModelClient } = await import("@flows/core");
  const { verify, triage, report } = await import("../src/nodes");
  const replies: Record<string, object> = {
    "Move the client under src/lib": { verdict: "conflict", evidence: "ADR-0007: src/db/client.ts creates the pool", conflictsWith: "ADR-0007" },
    "Rollback is untested": { verdict: "invalid", evidence: "rls.int.test.ts line 120 inserts a row and checks it is gone" },
    "Clarify the password note": { verdict: "valid", evidence: "README line 35: 'a password of your choice'" },
    "Block relative imports": { verdict: "valid", evidence: "eslint.config.mjs:16 lists only @/db", maxSeverity: "minor" },
    "Use a concrete example password": { verdict: "valid", evidence: ".env.example line 3 has <password>" },
  };
  const model = new MockModelClient().register((req) => {
    if (req.tag !== "review.verify") return undefined;
    const title = Object.keys(replies).find((k) => req.user.includes(k));
    return title ? JSON.stringify(replies[title]) : undefined;
  });
  const judge = new MockJudge().rule((key, _q, state: any) =>
    key === "category" ? { choice: state.finding.title === "Clarify the password note" ? "docs" : "brokenRule", confidence: 0.9 } : undefined,
  );
  const deps = {
    config: { models: { default: "m" }, review: { minConfidence: 0.6, dropSeverities: ["nit"], escalateAtSeverity: "blocker" } },
    model,
    judge,
  } as any;
  const merged = Object.keys(replies).map((title) => ({
    ...f({ title, reviewer: "architecture", severity: title === "Clarify the password note" ? "minor" : "major" }),
    reverses: title === "Use a concrete example password" ? "Remove committed database passwords" : undefined,
    alsoRaisedBy: [],
  }));
  const context = { diff: "", files: [], skipped: [], standards: [], adrs: [], allAdrs: [], prior: [], conventions: [] };
  const state = { input: { diff: "", label: "t" }, context, merged, rawFindings: [], log: [] } as any;

  const v = await verify(deps)(state);
  assert.equal(v.log![0]!.note, "3 valid, 1 invalid, 1 conflict");
  const tr = await triage(deps)({ ...state, ...v });
  const byTitle = Object.fromEntries(tr.findings!.map((x) => [x.title, x]));
  assert.equal(byTitle["Move the client under src/lib"]!.kept, false);
  assert.equal(byTitle["Rollback is untested"]!.kept, false);
  assert.equal(byTitle["Clarify the password note"]!.kept, true);
  assert.equal(byTitle["Block relative imports"]!.judgedSeverity, "minor", "an ADR's cap applies");
  assert.equal(byTitle["Use a concrete example password"]!.kept, false, "a finding that undoes an earlier round never reaches the agent");

  const md = (await report({ ...state, findings: tr.findings, verdict: "escalate", verdictReason: "x" })).report!;
  assert.match(md, /## Conflicts for you to decide[\s\S]*Move the client under src\/lib.*against ADR-0007/);
  assert.match(md, /Use a concrete example password.*against an earlier request \("Remove committed database passwords"\)/);
  assert.match(md, /## Dropped by verification[\s\S]*Rollback is untested.*line 120/);
});

test("fileText reads the cited file from the checkout and never outside it", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileText } = await import("../src/nodes");
  const dir = mkdtempSync(join(tmpdir(), "flows-verify-"));
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    assert.equal(fileText(dir, "a.ts"), "export const a = 1;\n");
    assert.match(fileText(dir, "../etc/passwd"), /not in the checkout/);
    assert.match(fileText(dir, "gone.ts"), /not in the checkout/);
    assert.match(fileText(undefined, "a.ts"), /not available/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the spec reviewer sees the ADRs its criteria name", async () => {
  const { adrsNamedIn } = await import("../src/reviewers");
  const adr = (id: string) => ({ id, decision: "", relations: [] }) as any;
  const named = adrsNamedIn(["ESLint blocks imports, as ADR-0006 scopes it."], [adr("ADR-0001"), adr("ADR-0006")]);
  assert.deepEqual(named.map((a) => a.id), ["ADR-0006"]);
});

test("later rounds get earlier findings and what changed; a first round gets nothing extra", async () => {
  const { laterRound } = await import("../src/reviewers");
  const base = { diff: "", files: [], skipped: [], standards: [], adrs: [], allAdrs: [], conventions: [] };
  const tpl = "PRIOR:\n{{prior}}\nDELTA:\n{{delta}}";
  assert.equal(laterRound({ ...base, prior: [] }, tpl), "");
  const prior = [{ round: 3, reviewer: "security", severity: "minor" as const, title: "Remove committed passwords", rationale: "A password is in git.", status: "sent" as const }];
  const out = laterRound({ ...base, prior, delta: "+changed" }, tpl);
  assert.match(out, /round 3, sent: \[minor\] Remove committed passwords, from security/);
  assert.match(out, /\+changed/);
});

test("findingDiff gives the judge only the lines near the finding", () => {
  const body = Array.from({ length: 60 }, (_, i) => `+line ${i + 1}`).join("\n");
  const diff = `diff --git a/x.ts b/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1,60 @@\n${body}\n`;
  const near = findingDiff(diff, "x.ts", 40, 5);
  assert.match(near, /^\+\+\+ b\/x\.ts$/m);
  assert.match(near, /^\+line 35$/m);
  assert.match(near, /^\+line 45$/m);
  assert.doesNotMatch(near, /^\+line 34$/m);
  assert.doesNotMatch(near, /^\+line 46$/m);
});

test("findingDiff counts removed lines at their place in the new file", () => {
  const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -10,4 +10,4 @@\n keep 10\n-old 11\n+new 11\n keep 12\n keep 13\n";
  const near = findingDiff(diff, "x.ts", 11, 0);
  assert.match(near, /^-old 11$/m);
  assert.match(near, /^\+new 11$/m);
  assert.doesNotMatch(near, /keep 12/);
});

test("findingDiff falls back to the whole file's diff without a line, or when the line isn't in the diff", () => {
  const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  assert.equal(findingDiff(diff, "x.ts", undefined), fileDiff(diff, "x.ts"));
  assert.equal(findingDiff(diff, "x.ts", 500), fileDiff(diff, "x.ts"));
});

test("severity certainty: kinds that share a severity add up, and without probabilities the kind's confidence stands", async () => {
  const { severityCertainty } = await import("../src/nodes");
  const { DEFAULT_CATEGORIES } = await import("@flows/core");
  // A live Jev answer: split between two major kinds, so a sure major.
  const split = { confidence: 0.39, probabilities: { bug: 0.46, security: 0, missedCriterion: 0.49, brokenRule: 0.05, other: 0 } };
  assert.equal(severityCertainty("missedCriterion", split, DEFAULT_CATEGORIES).toFixed(2), "1.00");
  // Split between a major and a blocker: unsure of the severity.
  const torn = { confidence: 0.5, probabilities: { bug: 0.45, security: 0.55 } };
  assert.equal(severityCertainty("security", torn, DEFAULT_CATEGORIES), 0.55);
  assert.equal(severityCertainty("other", { confidence: 0.6, probabilities: { other: 0.6, bug: 0.4 } }, DEFAULT_CATEGORIES), 0.6);
  assert.equal(severityCertainty("bug", { confidence: 0.3 }, DEFAULT_CATEGORIES), 0.3, "the LLM judge sends no probabilities");
});

test("triage logs a finding torn between severities, not one split between kinds of the same severity", async () => {
  const { MockJudge } = await import("@flows/core");
  const { triage } = await import("../src/nodes");
  const answers: Record<string, object> = {
    "Same severity": { choice: "missedCriterion", confidence: 0.39, probabilities: { bug: 0.46, missedCriterion: 0.49, brokenRule: 0.05 } },
    Torn: { choice: "security", confidence: 0.4, probabilities: { security: 0.4, bug: 0.35, taste: 0.25 } },
  };
  const judge = new MockJudge().rule((key, _q, state: any) => (key === "category" ? answers[state.finding.title] : undefined));
  const deps = { offline: true, config: { review: { minConfidence: 0.6, dropSeverities: ["nit"] } }, judge } as any;
  const verified = Object.keys(answers).map((title) => ({ ...f({ title }), alsoRaisedBy: [], verification: { verdict: "valid" as const, evidence: "x", checked: true } }));
  const out = await triage(deps)({ input: { diff: "", label: "t" }, verified, rawFindings: [], log: [] } as any);
  assert.match(out.log![0]!.note!, /1 didn't fit the table/);
  assert.deepEqual(out.log![0]!.details, ["no good fit (security, 0.40): Torn"]);
});
