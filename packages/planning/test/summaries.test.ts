import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeOptions } from "../src/graph";
import { asOption, asRequirement } from "../src/nodes";
import type { Requirement } from "../src/state";
import type { PlannedTask } from "@flows/core";
import { archSummary, describeDiff, diffRequirements, parseAdjust, scopeSummary, taskWarnings } from "../src/summaries";

const r = (id: string, over: Partial<Requirement> = {}): Requirement => ({
  id,
  title: `Title ${id}`,
  text: `Text ${id}`,
  area: "Scheduling",
  priority: "mvp",
  ...over,
});

test("diffRequirements reports additions, removals, edits and priority moves", () => {
  const before = [r("R-1"), r("R-2"), r("R-3"), r("R-4")];
  const after = [r("R-1"), r("R-2", { text: "new" }), r("R-3", { priority: "later" }), r("R-5")];
  assert.deepEqual(diffRequirements(before, after), { added: ["R-5"], removed: ["R-4"], changed: ["R-2"], toLater: ["R-3"], toMvp: [] });
  assert.equal(describeDiff(diffRequirements(before, before)), "No changes");
});

test("scope summary shows MVP titles by area, counts later ones and fits one screen at 30 requirements", () => {
  const areas = ["Accounts", "Scheduling", "Clocking", "Reports", "Settings"];
  const rs = Array.from({ length: 36 }, (_, i) => r(`R-${i + 1}`, { area: areas[i % 5]!, priority: i < 30 ? "mvp" : "later" }));
  const summary = scopeSummary(rs, []);
  assert.match(summary, /^Accounts \(6 MVP, 2 later\)$/m);
  assert.ok(!summary.includes("R-31"), "later requirements appear only as counts");
  assert.ok(summary.split("\n").length <= 40, `${summary.split("\n").length} lines`);
});

test("scope summary leads with what changed since the last notes", () => {
  assert.match(scopeSummary([r("R-1"), r("R-2")], [r("R-1")]), /^Since your last notes: Added R-2/);
});

test("parseAdjust reads the target letter and falls back to the recommended option", () => {
  assert.deepEqual(parseAdjust("C: use row-level security", ["A", "B", "C"], "A"), { target: "C", notes: "use row-level security" });
  assert.deepEqual(parseAdjust("b - fewer services", ["A", "B", "C"], "A"), { target: "B", notes: "fewer services" });
  assert.deepEqual(parseAdjust("cheaper hosting", ["A", "B", "C"], "A"), { target: "A", notes: "cheaper hosting" });
});

test("a rerun of the options replaces them by ID instead of adding copies", () => {
  const o = (id: string, pitch: string) => asOption({ pitch }, id, "angle");
  const merged = mergeOptions([o("A", "old"), o("B", "b"), o("C", "c")], [o("A", "new")]);
  assert.deepEqual(merged.map((x) => `${x.id}:${x.pitch}`), ["A:new", "B:b", "C:c"]);
});

test("architecture summary is two lines per option plus the recommendation", () => {
  const options = ["A", "B", "C"].map((id) => asOption({ pitch: `Pitch ${id}`, summary: "x".repeat(2000) }, id, "angle"));
  const summary = archSummary(options, "A: cheapest");
  assert.ok(!summary.includes("xxxx"), "full summaries stay in the detail file");
  assert.ok(summary.split("\n").length <= 12);
});

test("missing fields get defaults, so gates never print undefined", () => {
  const req = asRequirement({ text: "Managers can drag to create a shift. It snaps to 15 minutes." }, 0);
  assert.deepEqual(req, { id: "R-1", title: "Managers can drag to create a shift", text: req.text, area: "General", priority: "mvp" });
  assert.equal(asOption({}, "B", "angle").facts.monthlyCost, "?");
});

test("new ADRs record each Related to link on both sides", async () => {
  const { renderAdr } = await import("../src/nodes");
  const a = { id: "ADR-0001", title: "One", context: "c", clauses: ["d"], consequences: "q", related: ["ADR-0002"] };
  const b = { id: "ADR-0002", title: "Two", context: "c", clauses: ["d", "e"], consequences: "q" };
  assert.match(renderAdr(a, [a, b], "2026-11-15"), /^# ADR-0001: One\n\nDate: 2026-11-15\n\n## Status\nProposed\n\n## Relations\n- Related to \[ADR-0002\]\(0002-two\.md\)/);
  assert.match(renderAdr(b, [a, b], "2026-11-15"), /- Related to \[ADR-0001\]\(0001-one\.md\)/);
  assert.match(renderAdr(b, [a, b], "2026-11-15"), /## Decision\n1\. d\n2\. e\n/);
});

test("asClauses takes a list or numbered prose and drops the model's own numbers", async () => {
  const { asClauses } = await import("../src/nodes");
  assert.deepEqual(asClauses(["1. One rule.", "Two."]), ["One rule.", "Two."]);
  assert.deepEqual(asClauses("1) First.\n2) Second."), ["First.", "Second."]);
  assert.deepEqual(asClauses(undefined), []);
});

test("taskWarnings flags tasks a reviewer would have to interpret", () => {
  const task = (over: Partial<PlannedTask>): PlannedTask => ({
    id: "T-001", title: "t", description: "d", requirementIds: [], adrRefs: ["ADR-0001"], dependsOn: [],
    acceptanceCriteria: ["Returns 404 for a missing order"], risk: "low", ...over,
  });
  const adrs = [{ id: "ADR-0001", title: "a", context: "", clauses: ["x", "y"], consequences: "" }];
  assert.deepEqual(taskWarnings([task({})], adrs), []);
  assert.deepEqual(
    taskWarnings(
      [
        task({ id: "T-002", description: undefined, acceptanceCriteria: [] }),
        task({ id: "T-003", risk: "high", acceptanceCriteria: ["Errors are handled gracefully", "A repo-wide check finds every import"] }),
        task({ id: "T-004", adrRefs: ["ADR-0009"], acceptanceCriteria: ["Follows ADR-0001 clause 5", "A repo-wide check skips node_modules"] }),
      ],
      adrs,
    ),
    [
      "T-002: no description",
      "T-002: no acceptance criteria",
      'T-003: "Errors are handled gracefully" uses "gracefully"; say what the code does instead',
      'T-003: "A repo-wide check finds every import" is broad; say what it excludes',
      "T-003: high risk with nothing out of scope",
      "T-004: cites ADR-0009, which the plan doesn't have",
      "T-004: cites ADR-0001 clause 5, which doesn't exist",
    ],
  );
});
