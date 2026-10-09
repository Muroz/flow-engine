import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allAdrs, checkAdrs, parseRelations, resolveAdrs, type AdrRef, type AdrRelation, type AdrStatus } from "../src";

const adr = (id: string, status: AdrStatus, ...relations: AdrRelation[]): AdrRef => ({
  id,
  title: id,
  path: `${id}.md`,
  status,
  relations,
  decision: "",
});

test("parseRelations reads each kind, linked or plain, and ignores other lines", () => {
  const block = [
    "- Supersedes [ADR-0002](0002-old.md): the old rule was too broad.",
    "- Amended by ADR-0009",
    "- related to [ADR-0003](0003-x.md)",
    "Some prose.",
  ].join("\n");
  assert.deepEqual(parseRelations(block), [
    { kind: "Supersedes", id: "ADR-0002" },
    { kind: "Amended by", id: "ADR-0009" },
    { kind: "Related to", id: "ADR-0003" },
  ]);
});

test("a task's ADRs follow supersessions to the replacement and bring their amendments", () => {
  const adrs = [
    adr("ADR-0001", "accepted", { kind: "Amended by", id: "ADR-0006" }),
    adr("ADR-0002", "superseded", { kind: "Superseded by", id: "ADR-0004" }),
    adr("ADR-0003", "deprecated"),
    adr("ADR-0004", "accepted", { kind: "Supersedes", id: "ADR-0002" }),
    adr("ADR-0006", "accepted", { kind: "Amends", id: "ADR-0001" }),
  ];
  const ids = (only?: string[]) => resolveAdrs(adrs, only).map((a) => a.id);
  assert.deepEqual(ids(["ADR-0001"]), ["ADR-0001", "ADR-0006"]);
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
    checkAdrs([adr("ADR-0001", "accepted", { kind: "Amended by", id: "ADR-0002" }), adr("ADR-0002", "accepted", { kind: "Amends", id: "ADR-0001" })]),
    [],
  );
});

test("allAdrs reads numbered files only and parses status and relations", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flows-adrs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs/adr"), { recursive: true });
  writeFileSync(join(dir, "docs/adr/README.md"), "# How we write ADRs");
  writeFileSync(
    join(dir, "docs/adr/0002-new.md"),
    "# ADR-0002: New rule\n\n## Status\nAccepted on 2026-10-09\n\n## Relations\n- Supersedes [ADR-0001](0001-old.md)\n\n## Decision\nDo the new thing.\n",
  );
  const [only] = allAdrs({ artifactsDir: dir } as any);
  assert.equal(allAdrs({ artifactsDir: dir } as any).length, 1);
  assert.equal(only!.status, "accepted");
  assert.deepEqual(only!.relations, [{ kind: "Supersedes", id: "ADR-0001" }]);
  assert.equal(only!.decision, "Do the new thing.");
});
