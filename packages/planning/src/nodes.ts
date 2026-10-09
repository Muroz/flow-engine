/**
 * Planning nodes. Scaffolded: every node works (and runs offline), but the
 * prompts are first drafts — expect to iterate on them in /prompts/planning.
 *
 * Note the pattern around every human gate: the *model call* happens in one
 * node and the *gate* in the next. When a graph resumes after interrupt(),
 * the interrupted node re-runs from the top — so anything before interrupt()
 * in the same node would be paid for twice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadPrompt,
  logEntry,
  modelFor,
  noul,
  parseJsonReply,
  render,
  slugify,
  writeRunFile,
  writeTasksYaml,
  type FlowDeps,
  type GateDecision,
  type GateRequest,
  type PlannedTask,
} from "@flows/core";
import { END, interrupt, Send } from "@langchain/langgraph";
import type { ArchFacts, ArchOption, DraftAdr, PlanningState, PlanningUpdate, Requirement } from "./state";
import { archDetail, archSummary, mvp, parseAdjust, planDetail, planSummary, scopeDetail, scopeSummary } from "./summaries";

const gate = (req: GateRequest) => interrupt(req) as GateDecision;
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
const reqList = (rs: Requirement[]) => rs.map((r) => `- ${r.id}: ${r.text}`).join("\n");
const fullReqList = (rs: Requirement[]) =>
  rs.map((r) => `- ${r.id} [${r.priority}] [${r.area}] ${r.title}: ${r.text}`).join("\n");

/** Lenses for the architecture fan-out. Diversity comes from the angle — and from using different models per angle if you like. */
export const ARCH_ANGLES = [
  "simplest thing that could work, minimal new infrastructure",
  "built to scale and evolve over 2+ years",
  "buy over build: lean on managed services and existing libraries",
];

// ── discovery ───────────────────────────────────────────────────────────────

export const intake = async (s: PlanningState): Promise<PlanningUpdate> => ({
  brief: readFileSync(s.briefPath, "utf8"),
  log: [logEntry("planning.intake")],
});

export const assessBrief =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const a = await deps.judge.ask(
      { brief: s.brief },
      {
        complete: noul(
          "Is this brief complete enough to write requirements? It should name the users, the core flows, constraints (stack, budget, deadlines) and what success looks like.",
        ),
      },
    );
    return {
      briefComplete: a.complete.p >= 0.7,
      log: [logEntry("planning.assessBrief", { note: `${deps.judge.name}: complete p=${a.complete.p.toFixed(2)}` })],
    };
  };

export const askQuestions =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.questions",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a consultant preparing discovery questions for a client.",
      user: render(loadPrompt("planning/questions"), { brief: s.brief }),
    });
    const { questions = [] } = parseJsonReply<{ questions?: string[] }>(res.text, {});
    return { questions, log: [logEntry("planning.askQuestions", { model: res.model, costUsd: res.costUsd })] };
  };

export const clarify = async (s: PlanningState): Promise<PlanningUpdate> => {
  const d = gate({
    gate: "clarify",
    title: "The brief has gaps — answer what you can",
    summary: bullets(s.questions),
    options: ["answered", "proceed anyway"],
  });
  const answers = d.notes ?? "(no answers given — make reasonable assumptions and list them)";
  return {
    brief: `${s.brief}\n\n## Answers to discovery questions (round ${s.discoveryRounds + 1})\n${answers}`,
    discoveryRounds: s.discoveryRounds + 1,
    briefComplete: d.decision === "proceed anyway" ? true : undefined,
    log: [logEntry("planning.clarify", { note: d.decision })],
  };
};

// ── requirements & scope ────────────────────────────────────────────────────

export const writeRequirements =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    // With feedback on an existing list, edit that list instead of starting over.
    const revising = s.requirements.length > 0 && !!s.scopeFeedback;
    const res = await deps.model.complete({
      tag: revising ? "planning.reviseRequirements" : "planning.requirements",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a product-minded senior engineer writing crisp, testable requirements.",
      user: revising
        ? render(loadPrompt("planning/revise-requirements"), { requirements: fullReqList(s.requirements), feedback: s.scopeFeedback! })
        : render(loadPrompt("planning/requirements"), { brief: s.brief }),
    });
    const { requirements = [] } = parseJsonReply<{ requirements?: Partial<Requirement>[] }>(res.text, {});
    const parsed = requirements.map(asRequirement);
    return {
      requirements: parsed,
      previousRequirements: revising ? s.requirements : [],
      scopeFeedback: undefined,
      log: [
        logEntry(revising ? "planning.reviseRequirements" : "planning.requirements", {
          model: res.model,
          costUsd: res.costUsd,
          note: `${parsed.length} requirements (${mvp(parsed).length} MVP)`,
        }),
      ],
    };
  };

export const approveScope =
  (detailDir: string) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const detailPath = writeRunFile(detailDir, "scope.md", scopeDetail(s.requirements));
    const d = gate({
      gate: "approve-scope",
      title: `Approve scope: ${mvp(s.requirements).length} MVP requirements, ${s.requirements.length - mvp(s.requirements).length} later`,
      summary: scopeSummary(s.requirements, s.previousRequirements),
      options: ["approve", "revise", "discard"],
      detailPath,
    });
    return {
      scopeDecision: d.decision as PlanningState["scopeDecision"],
      scopeFeedback: d.decision === "revise" ? d.notes : undefined,
      log: [logEntry("planning.approveScope", { note: d.decision })],
    };
  };

// ── architecture (fan-out) ──────────────────────────────────────────────────

export const proposeOption =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.option",
      model: modelFor(deps.config, "planner"), // try a different model per angle for real diversity
      json: true,
      system: "You are a pragmatic software architect.",
      user: render(loadPrompt("planning/option"), {
        angle: s.currentAngle,
        requirements: reqList(mvp(s.requirements)),
        brief: s.brief,
        feedback: s.archFeedback ?? "(none)",
      }),
    });
    const id = String.fromCharCode(65 + ARCH_ANGLES.indexOf(s.currentAngle ?? ""));
    return {
      options: [asOption(parseJsonReply(res.text, {}), id, s.currentAngle ?? "")],
      log: [logEntry(`planning.option.${id}`, { model: res.model, costUsd: res.costUsd })],
    };
  };

export const adjustOption =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const target = s.options.find((o) => o.id === s.adjustTarget) ?? s.options[0]!;
    const res = await deps.model.complete({
      tag: "planning.adjustOption",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a pragmatic software architect.",
      user: render(loadPrompt("planning/adjust-option"), {
        option: JSON.stringify(target, null, 2),
        feedback: s.archFeedback ?? "",
        requirements: reqList(mvp(s.requirements)),
      }),
    });
    return {
      options: [asOption(parseJsonReply(res.text, {}), target.id, target.angle)],
      archFeedback: undefined,
      log: [logEntry(`planning.adjust.${target.id}`, { model: res.model, costUsd: res.costUsd })],
    };
  };

export const compareOptions =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.compare",
      model: modelFor(deps.config, "reviewer"), // a different model judges the options
      json: true,
      system: "You are a principal engineer choosing between architecture options for a small team.",
      user: render(loadPrompt("planning/compare"), {
        requirements: reqList(mvp(s.requirements)),
        options: s.options
          .map((o) => `### Option ${o.id} (${o.angle})\n${o.pitch}\n${o.summary}\nFacts: ${JSON.stringify(o.facts)}\nTrade-offs:\n${bullets(o.tradeoffs)}`)
          .join("\n\n"),
      }),
    });
    const { recommended = "A", why = "" } = parseJsonReply<{ recommended?: string; why?: string }>(res.text, {});
    return { recommendation: `${recommended}: ${why}`, log: [logEntry("planning.compare", { model: res.model, costUsd: res.costUsd, note: `recommends ${recommended}` })] };
  };

export const pickArchitecture =
  (detailDir: string) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const rec = s.recommendation?.split(":")[0] ?? "A";
    const ids = s.options.map((o) => o.id);
    const detailPath = writeRunFile(detailDir, "architecture.md", archDetail(s.options, s.recommendation));
    const d = gate({
      gate: "pick-architecture",
      title: "Pick an architecture",
      summary: archSummary(s.options, s.recommendation),
      options: [rec, ...ids.filter((id) => id !== rec), "revise", "adjust", "discard"],
      detailPath,
    });
    const log = [logEntry("planning.pickArchitecture", { note: d.decision })];
    if (d.decision === "revise") return { archDecision: "revise", archFeedback: d.notes, log };
    if (d.decision === "adjust") {
      const { target, notes } = parseAdjust(d.notes ?? "", ids, rec);
      return { archDecision: "adjust", adjustTarget: target, archFeedback: notes, log };
    }
    const chosen = s.options.find((o) => o.id === d.decision);
    return { archDecision: chosen ? "pick" : "discard", chosen, log };
  };

// ── ADRs & breakdown ────────────────────────────────────────────────────────

export const writeAdrs =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const res = await deps.model.complete({
      tag: "planning.adrs",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You write short Architecture Decision Records.",
      user: render(loadPrompt("planning/adrs"), {
        chosen: `${s.chosen!.summary}\nTrade-offs:\n${bullets(s.chosen!.tradeoffs)}`,
        requirements: reqList(mvp(s.requirements)),
      }),
    });
    const { adrs = [] } = parseJsonReply<{ adrs?: Omit<DraftAdr, "id">[] }>(res.text, {});
    // Models sometimes return a single string or junk for "related".
    return {
      adrs: adrs.map((a, i) => ({
        ...a,
        id: `ADR-${String(i + 1).padStart(4, "0")}`,
        related: Array.isArray(a.related) ? a.related.map(String).filter((r) => /^ADR-\d{4}$/.test(r)) : [],
      })),
      log: [logEntry("planning.adrs", { model: res.model, costUsd: res.costUsd, note: `${adrs.length} ADRs` })],
    };
  };

export const breakdown =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const gaps = s.coverage.filter((c) => !c.covered).map((c) => c.requirementId);
    const res = await deps.model.complete({
      tag: "planning.breakdown",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You break projects into small, independently reviewable tasks with explicit dependencies.",
      user: render(loadPrompt("planning/breakdown"), {
        requirements: reqList(mvp(s.requirements)),
        adrs: s.adrs.map((a) => `${a.id}: ${a.title} — ${a.decision}`).join("\n"),
        previous: s.tasks.length ? JSON.stringify(s.tasks) : "(none)",
        gaps: gaps.length ? `GAPS — these requirements are not covered yet: ${gaps.join(", ")}` : "",
      }),
    });
    const { tasks = [] } = parseJsonReply<{ tasks?: PlannedTask[] }>(res.text, {});
    return {
      tasks,
      breakdownRounds: s.breakdownRounds + 1,
      log: [logEntry("planning.breakdown", { model: res.model, costUsd: res.costUsd, note: `${tasks.length} tasks` })],
    };
  };

// ── coverage verifier (judge + deterministic) ───────────────────────────────

/**
 * One Jev call, many questions: "is R-1 covered?", "is R-2 covered?", … all
 * answered in a single pass over the same state (the task list).
 */
export const checkCoverage =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const scope = mvp(s.requirements);
    const questions = Object.fromEntries(
      scope.map((r) => [
        r.id.replace(/\W/g, "_"),
        noul(`Is requirement ${r.id} ("${r.text}") fully delivered by these tasks' acceptance criteria?`),
      ]),
    );
    const answers = await deps.judge.ask({ tasks: s.tasks.map(({ id, title, requirementIds, acceptanceCriteria }) => ({ id, title, requirementIds, acceptanceCriteria })) }, questions);

    // Deterministic half: every task must trace back to a real requirement.
    const known = new Set(scope.map((r) => r.id));
    const orphans = s.tasks.filter((t) => !t.requirementIds.some((id) => known.has(id))).map((t) => t.id);

    const coverage = scope.map((r) => {
      const p = (answers as Record<string, { p: number }>)[r.id.replace(/\W/g, "_")]?.p ?? 0;
      return { requirementId: r.id, p, covered: p >= 0.6 };
    });
    const gaps = coverage.filter((c) => !c.covered).map((c) => c.requirementId);
    return {
      coverage,
      log: [logEntry("planning.coverage", { note: `${deps.judge.name}: gaps [${gaps.join(", ")}], orphan tasks [${orphans.join(", ")}]` })],
    };
  };

export const approvePlan =
  (detailDir: string) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const gaps = s.coverage.filter((c) => !c.covered).map((c) => c.requirementId);
    const detailPath = writeRunFile(detailDir, "plan.md", planDetail(s.tasks));
    const d = gate({
      gate: "approve-plan",
      title: `Approve plan: ${s.tasks.length} tasks, ${s.adrs.length} ADRs`,
      summary: planSummary(s.chosen, s.adrs, s.tasks, gaps),
      options: ["approve", "discard"],
      detailPath,
    });
    return { planApproved: d.decision === "approve", log: [logEntry("planning.approvePlan", { note: d.decision })] };
  };

// ── emit ────────────────────────────────────────────────────────────────────

/** Writes the artifacts delivery and review consume. `outDir` is a proposal folder unless you pass --write. */
export const emit = (outDir: string) => async (s: PlanningState): Promise<PlanningUpdate> => {
  const prd = [
    "# PRD",
    "",
    "## Brief",
    s.brief ?? "",
    "",
    "## Requirements",
    reqList(mvp(s.requirements)),
    "",
    "## Later",
    reqList(s.requirements.filter((r) => r.priority === "later")) || "(none)",
    "",
    "## Architecture",
    `${s.chosen?.summary ?? ""}`,
  ].join("\n");
  const files = [writeRunFile(outDir, "docs/prd.md", prd)];
  for (const a of s.adrs) files.push(writeRunFile(outDir, join("docs/adr", adrFileName(a)), renderAdr(a, s.adrs)));
  files.push(writeTasksYaml(outDir, s.tasks));
  return { emitted: files, log: [logEntry("planning.emit", { note: `${files.length} files → ${outDir}` })] };
};

const adrFileName = (a: DraftAdr) => `${a.id.slice(4)}-${slugify(a.title)}.md`;

/**
 * A new ADR in the project's format. "Related to" links are written on both
 * ADRs, whichever one the model listed them under.
 */
export function renderAdr(a: DraftAdr, all: DraftAdr[]): string {
  const byId = new Map(all.map((x) => [x.id, x]));
  const related = new Set([
    ...(a.related ?? []),
    ...all.filter((x) => x.related?.includes(a.id)).map((x) => x.id),
  ]);
  related.delete(a.id);
  const links = [...related]
    .filter((id) => byId.has(id))
    .sort()
    .map((id) => `- Related to [${id}](${adrFileName(byId.get(id)!)})`);
  return [
    `# ${a.id}: ${a.title}`,
    "",
    "## Status",
    "Proposed",
    "",
    "## Relations",
    links.length ? links.join("\n") : "None.",
    "",
    "## Context",
    a.context,
    "",
    "## Decision",
    a.decision,
    "",
    "## Consequences",
    a.consequences,
    "",
  ].join("\n");
}

// ── routing ─────────────────────────────────────────────────────────────────

export const afterAssess = (s: PlanningState) => (s.briefComplete || s.discoveryRounds >= 2 ? "writeRequirements" : "askQuestions");
export const afterPick = (s: PlanningState) => {
  if (s.archDecision === "pick" && s.chosen) return "writeAdrs";
  if (s.archDecision === "adjust") return "adjustOption";
  if (s.archDecision === "revise") return proposeAll(s);
  return END;
};

/** One `proposeOption` branch per angle. */
export const proposeAll = (s: PlanningState) => ARCH_ANGLES.map((angle) => new Send("proposeOption", { ...s, currentAngle: angle }));

export const afterScope = (s: PlanningState) => {
  if (s.scopeDecision === "approve") return proposeAll(s);
  return s.scopeDecision === "revise" ? "writeRequirements" : END;
};

/** Models leave fields out; fill them so gates never print "undefined". */
export function asRequirement(r: Partial<Requirement>, i: number): Requirement {
  const text = String(r.text ?? "");
  return {
    id: String(r.id ?? `R-${i + 1}`),
    title: String(r.title ?? text.split(/[.:]/)[0]!.split(/\s+/).slice(0, 8).join(" ")),
    text,
    area: String(r.area ?? "General"),
    priority: r.priority === "later" ? "later" : "mvp",
  };
}

export function asOption(o: Omit<Partial<ArchOption>, "facts"> & { facts?: Partial<ArchFacts> }, id: string, angle: string): ArchOption {
  const f: Partial<ArchFacts> = o.facts ?? {};
  const fact = (x: unknown) => String(x ?? "?");
  return {
    id,
    angle,
    pitch: String(o.pitch ?? o.summary?.split(". ")[0] ?? ""),
    facts: { firstDelivery: fact(f.firstDelivery), monthlyCost: fact(f.monthlyCost), opsBurden: fact(f.opsBurden), lockIn: fact(f.lockIn) },
    summary: String(o.summary ?? ""),
    tradeoffs: Array.isArray(o.tradeoffs) ? o.tradeoffs.map(String) : [],
  };
}
export const afterCoverage = (s: PlanningState) =>
  s.coverage.some((c) => !c.covered) && s.breakdownRounds < 2 ? "breakdown" : "approvePlan";
export const afterPlanGate = (s: PlanningState) => (s.planApproved ? "emit" : END);
