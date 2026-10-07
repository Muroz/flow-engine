import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeOptions } from "../src/graph";
import { asOption, asRequirement } from "../src/nodes";
import type { Requirement } from "../src/state";
import { archSummary, describeDiff, diffRequirements, parseAdjust, scopeSummary } from "../src/summaries";

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
