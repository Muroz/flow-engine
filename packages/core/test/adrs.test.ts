import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adrBrief, allAdrs, checkAdrs, clauseRefs, parseAdrText, parseRelations, renderAdr, resolveAdrs, type AdrRef, type AdrRelation, type AdrStatus } from "../src";

const adr = (id: string, status: AdrStatus, ...relations: AdrRelation[]): AdrRef => ({
  id,
  title: id,
  path: `${id}.md`,
  status,
  relations,
  clauses: [1, 2, 3].map((n) => ({ n, text: `rule ${n}` })),
});

test("parseRelations reads each kind, linked or plain, and ignores other lines", () => {
  const block = [
    "- Supersedes [ADR-0002](0002-old.md): the old rule was too broad.",
    "- Amended by ADR-0009 clauses 2 and 4",
    "- related to [ADR-0003](0003-x.md)",
    "Some prose.",
  ].join("\n");
  assert.deepEqual(parseRelations(block), [
    { kind: "Supersedes", id: "ADR-0002" },
    { kind: "Amended by", id: "ADR-0009", clauses: [2, 4] },
    { kind: "Related to", id: "ADR-0003" },
  ]);
});

test("a task's ADRs follow supersessions to the replacement and bring their amendments", () => {
  const adrs = [
    adr("ADR-0001", "accepted", { kind: "Amended by", id: "ADR-0006", clauses: [2] }),
    adr("ADR-0002", "superseded", { kind: "Superseded by", id: "ADR-0004" }),
    adr("ADR-0003", "deprecated"),
    adr("ADR-0004", "accepted", { kind: "Supersedes", id: "ADR-0002" }),
    adr("ADR-0006", "accepted", { kind: "Amends", id: "ADR-0001", clauses: [2] }),
  ];
  const ids = (only?: string[]) => resolveAdrs(adrs, only).map((a) => a.id);
  assert.deepEqual(ids(["ADR-0001"]), ["ADR-0001", "ADR-0006"]);
  assert.deepEqual(ids(["ADR-0001 clause 2"]), ["ADR-0001", "ADR-0006"], "a cited clause brings its whole ADR");
  assert.deepEqual(ids(["ADR-0002"]), ["ADR-0004"]);
  assert.deepEqual(ids(["ADR-0003"]), []);
  assert.deepEqual(ids(), ["ADR-0001", "ADR-0004", "ADR-0006"]);
});

test("checkAdrs finds one-sided links, missing ADRs and statuses that disagree", () => {
  const problems = checkAdrs([
    adr("ADR-0001", "accepted", { kind: "Superseded by", id: "ADR-0002" }),
    adr("ADR-0002", "accepted", { kind: "Related to", id: "ADR-0009" }),
    adr("ADR-0003", "superseded"),
  ]);
  assert.deepEqual(problems, [
    'ADR-0001: "Superseded by ADR-0002", but ADR-0002 doesn\'t record "Supersedes ADR-0001"',
    "ADR-0001: has \"Superseded by\" but its status is accepted",
    'ADR-0002: "Related to ADR-0009" points at an ADR that doesn\'t exist',
    "ADR-0003: status is superseded but no \"Superseded by\" relation names the replacement",
  ]);
  assert.deepEqual(
    checkAdrs([adr("ADR-0001", "accepted", { kind: "Amended by", id: "ADR-0002", clauses: [3] }), adr("ADR-0002", "accepted", { kind: "Amends", id: "ADR-0001", clauses: [3] })]),
    [],
  );
});

test("checkAdrs holds amendments to named clauses that exist, recorded alike on both sides", () => {
  assert.deepEqual(
    checkAdrs([
      adr("ADR-0001", "accepted", { kind: "Amended by", id: "ADR-0002", clauses: [2] }),
      adr("ADR-0002", "accepted", { kind: "Amends", id: "ADR-0001", clauses: [3] }, { kind: "Amends", id: "ADR-0003" }, { kind: "Amends", id: "ADR-0004", clauses: [9] }),
      adr("ADR-0003", "accepted", { kind: "Amended by", id: "ADR-0002" }),
      adr("ADR-0004", "accepted", { kind: "Amended by", id: "ADR-0002", clauses: [9] }),
    ]),
    [
      'ADR-0001: "Amended by ADR-0002 clause 2", but ADR-0002 doesn\'t record "Amends ADR-0001 clause 2"',
      'ADR-0002: "Amends ADR-0001 clause 3", but ADR-0001 doesn\'t record "Amended by ADR-0002 clause 3"',
      'ADR-0002: "Amends ADR-0003" names no clause; write "Amends ADR-0003 clause N"',
      'ADR-0002: "Amends ADR-0004 clause 9", but ADR-0004 has no clause 9',
      'ADR-0003: "Amended by ADR-0002" names no clause; write "Amended by ADR-0002 clause N"',
      'ADR-0004: "Amended by ADR-0002 clause 9", but ADR-0004 has no clause 9',
    ],
  );
  const citing = { ...adr("ADR-0005", "accepted"), clauses: [{ n: 1, text: "Narrows ADR-0004 clauses 2 and 7." }] };
  assert.deepEqual(checkAdrs([adr("ADR-0004", "accepted"), citing]), ["ADR-0005 clause 1 cites ADR-0004 clause 7, which doesn't exist"]);
});

test("clauseRefs finds single and listed clauses", () => {
  assert.deepEqual(clauseRefs("see ADR-0001 clause 3, and adr-0002 clauses 1, 2 and 4"), [
    { id: "ADR-0001", clause: 3 },
    { id: "ADR-0002", clause: 1 },
    { id: "ADR-0002", clause: 2 },
    { id: "ADR-0002", clause: 4 },
  ]);
});

test("renderAdr fills the template, and the result parses back with no format problems", () => {
  const text = renderAdr({
    id: "ADR-0006",
    title: "Scanned repos are untrusted",
    date: "2026-11-15",
    relations: [{ kind: "Amends", id: "ADR-0001", file: "0001-git.md", clauses: [2], note: "allows reading config files" }],
    context: "Repos can name commands in their config.",
    clauses: ["git never runs a program a repo names.", "Overrides go through runGit only."],
    consequences: "Each new git command needs a check.",
  });
  assert.match(text, /^# ADR-0006: Scanned repos are untrusted\n\nDate: 2026-11-15\n\n## Status\nProposed\n/);
  assert.match(text, /- Amends \[ADR-0001\]\(0001-git\.md\) clause 2: allows reading config files/);
  assert.match(text, /## Decision\n1\. git never runs a program a repo names\.\n2\. Overrides go through runGit only\./);
  const parsed = parseAdrText(text, "docs/adr/0006-untrusted.md");
  assert.equal(parsed.formatProblems, undefined);
  assert.equal(parsed.date, "2026-11-15");
  assert.deepEqual(parsed.relations, [{ kind: "Amends", id: "ADR-0001", clauses: [2] }]);
  assert.deepEqual(parsed.clauses.map((c) => c.n), [1, 2]);
});

test("parseAdrText reports where a file departs from the template", () => {
  const legacy = "# ADR-0003: Old style\n\n## Status\nAccepted\n\n## Context\nWhy.\n\n## Decision\nOne prose rule.\n\n### Exception\nA carve-out.\n\n## Consequences\nCosts.\n";
  const parsed = parseAdrText(legacy, "docs/adr/0003-old.md");
  assert.deepEqual(parsed.clauses, [{ n: 1, text: "One prose rule.\n\n### Exception\nA carve-out." }], "prose still reaches reviewers, as clause 1");
  assert.deepEqual(parsed.formatProblems, [
    'no "Date: YYYY-MM-DD" line under the title',
    "sections must be Status, Relations, Context, Decision, Consequences, in that order; found Status, Context, Decision, Consequences",
    "the Decision must be a numbered list of clauses",
  ]);
  const gap = parseAdrText(legacy.replace("One prose rule.\n\n### Exception\nA carve-out.", "1. First.\n   Continues here.\n3. Third.\nStray text."), "docs/adr/0003-old.md");
  assert.deepEqual(gap.clauses, [{ n: 1, text: "First. Continues here." }, { n: 3, text: "Third." }]);
  assert.ok(gap.formatProblems!.includes("clause 3 is out of order; number clauses 1, 2, 3 and so on"));
  assert.ok(gap.formatProblems!.includes('the Decision holds text outside its numbered clauses: "Stray text."'));
});

test("adrBrief numbers the clauses and flags the amended ones", () => {
  const a = adr("ADR-0001", "accepted", { kind: "Amended by", id: "ADR-0006", clauses: [2] });
  assert.equal(
    adrBrief(a),
    "ADR-0001: ADR-0001 (amended by ADR-0006 clause 2)\n1. rule 1\n2. rule 2 [Amended by ADR-0006; that ADR's clauses take precedence here.]\n3. rule 3",
  );
});

test("allAdrs reads numbered files only and parses status and relations", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flows-adrs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/adr"), { recursive: true });
  writeFileSync(join(dir, "docs/adr/README.md"), "# How we write ADRs");
  writeFileSync(
    join(dir, "docs/adr/0002-new.md"),
    "# ADR-0002: New rule\n\nDate: 2026-10-09\n\n## Status\nAccepted on 2026-10-09\n\n## Relations\n- Supersedes [ADR-0001](0001-old.md)\n\n## Context\nWhy.\n\n## Decision\n1. Do the new thing.\n\n## Consequences\nCosts.\n",
  );
  const [only] = allAdrs({ artifactsDir: dir } as any);
  assert.equal(allAdrs({ artifactsDir: dir } as any).length, 1);
  assert.equal(only!.status, "accepted");
  assert.deepEqual(only!.relations, [{ kind: "Supersedes", id: "ADR-0001" }]);
  assert.deepEqual(only!.clauses, [{ n: 1, text: "Do the new thing." }]);
  assert.equal(only!.formatProblems, undefined);
});
