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
import { END, interrupt } from "@langchain/langgraph";
import type { ArchOption, DraftAdr, PlanningState, PlanningUpdate, Requirement } from "./state";

const gate = (req: GateRequest) => interrupt(req) as GateDecision;
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
const reqList = (rs: Requirement[]) => rs.map((r) => `- ${r.id}: ${r.text}`).join("\n");

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
    const res = await deps.model.complete({
      tag: "planning.requirements",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a product-minded senior engineer writing crisp, testable requirements.",
      user: render(loadPrompt("planning/requirements"), { brief: s.brief }),
    });
    const { requirements = [] } = parseJsonReply<{ requirements?: Requirement[] }>(res.text, {});
    return { requirements, log: [logEntry("planning.requirements", { model: res.model, costUsd: res.costUsd, note: `${requirements.length} requirements` })] };
  };

export const approveScope = async (s: PlanningState): Promise<PlanningUpdate> => {
  const d = gate({
    gate: "approve-scope",
    title: `Approve scope (${s.requirements.length} requirements)`,
    summary: reqList(s.requirements),
    options: ["approve", "revise", "stop"],
  });
  return {
    scopeDecision: d.decision as PlanningState["scopeDecision"],
    brief: d.decision === "revise" && d.notes ? `${s.brief}\n\n## Scope feedback\n${d.notes}` : s.brief,
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
      user: render(loadPrompt("planning/option"), { angle: s.currentAngle, requirements: reqList(s.requirements), brief: s.brief }),
    });
    const o = parseJsonReply<{ summary?: string; tradeoffs?: string[] }>(res.text, {});
    const id = String.fromCharCode(65 + ARCH_ANGLES.indexOf(s.currentAngle ?? ""));
    return {
      options: [{ id, angle: s.currentAngle ?? "", summary: o.summary ?? "", tradeoffs: o.tradeoffs ?? [] }],
      log: [logEntry(`planning.option.${id}`, { model: res.model, costUsd: res.costUsd })],
    };
  };

export const compareOptions =
  (deps: FlowDeps) =>
  async (s: PlanningState): Promise<PlanningUpdate> => {
    const options = [...s.options].sort((a, b) => a.id.localeCompare(b.id));
    const res = await deps.model.complete({
      tag: "planning.compare",
      model: modelFor(deps.config, "reviewer"), // a different model judges the options
      json: true,
      system: "You are a principal engineer choosing between architecture options for a small team.",
      user: render(loadPrompt("planning/compare"), {
        requirements: reqList(s.requirements),
        options: options.map((o) => `### Option ${o.id} (${o.angle})\n${o.summary}\nTrade-offs:\n${bullets(o.tradeoffs)}`).join("\n\n"),
      }),
    });
    const { recommended = "A", why = "" } = parseJsonReply<{ recommended?: string; why?: string }>(res.text, {});
    // Don't return `options` here: its reducer is concat, so it would duplicate them.
    return { recommendation: `${recommended}: ${why}`, log: [logEntry("planning.compare", { model: res.model, costUsd: res.costUsd, note: `recommends ${recommended}` })] };
  };

export const pickArchitecture = async (s: PlanningState): Promise<PlanningUpdate> => {
  const rec = s.recommendation?.split(":")[0] ?? "A";
  const ids = [rec, ...s.options.map((o) => o.id).filter((id) => id !== rec)];
  const d = gate({
    gate: "pick-architecture",
    title: "Pick an architecture",
    summary: [
      ...s.options.map((o) => `${o.id} — ${o.angle}\n   ${o.summary}`),
      "",
      `Recommended: ${s.recommendation}`,
    ].join("\n"),
    options: [...ids, "stop"],
  });
  const chosen = s.options.find((o) => o.id === d.decision);
  return { chosen, log: [logEntry("planning.pickArchitecture", { note: d.decision })] };
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
        requirements: reqList(s.requirements),
      }),
    });
    const { adrs = [] } = parseJsonReply<{ adrs?: Omit<DraftAdr, "id">[] }>(res.text, {});
    return {
      adrs: adrs.map((a, i) => ({ ...a, id: `ADR-${String(i + 1).padStart(4, "0")}` })),
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
        requirements: reqList(s.requirements),
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
    const questions = Object.fromEntries(
      s.requirements.map((r) => [
        r.id.replace(/\W/g, "_"),
        noul(`Is requirement ${r.id} ("${r.text}") fully delivered by these tasks' acceptance criteria?`),
      ]),
    );
    const answers = await deps.judge.ask({ tasks: s.tasks.map(({ id, title, requirementIds, acceptanceCriteria }) => ({ id, title, requirementIds, acceptanceCriteria })) }, questions);

    // Deterministic half: every task must trace back to a real requirement.
    const known = new Set(s.requirements.map((r) => r.id));
    const orphans = s.tasks.filter((t) => !t.requirementIds.some((id) => known.has(id))).map((t) => t.id);

    const coverage = s.requirements.map((r) => {
      const p = (answers as Record<string, { p: number }>)[r.id.replace(/\W/g, "_")]?.p ?? 0;
      return { requirementId: r.id, p, covered: p >= 0.6 };
    });
    const gaps = coverage.filter((c) => !c.covered).map((c) => c.requirementId);
    return {
      coverage,
      log: [logEntry("planning.coverage", { note: `${deps.judge.name}: gaps [${gaps.join(", ")}], orphan tasks [${orphans.join(", ")}]` })],
    };
  };

export const approvePlan = async (s: PlanningState): Promise<PlanningUpdate> => {
  const gaps = s.coverage.filter((c) => !c.covered).map((c) => c.requirementId);
  const d = gate({
    gate: "approve-plan",
    title: `Approve plan: ${s.tasks.length} tasks, ${s.adrs.length} ADRs`,
    summary: [
      `Architecture: ${s.chosen?.id} — ${s.chosen?.angle}`,
      ...s.adrs.map((a) => `${a.id}: ${a.title}`),
      "",
      ...s.tasks.map((t) => `${t.id} [${t.risk}] ${t.title}${t.dependsOn.length ? `  ← ${t.dependsOn.join(", ")}` : ""}`),
      ...(gaps.length ? ["", `⚠ still uncovered: ${gaps.join(", ")}`] : []),
    ].join("\n"),
    options: ["approve", "stop"],
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
    reqList(s.requirements),
    "",
    "## Architecture",
    `${s.chosen?.summary ?? ""}`,
  ].join("\n");
  const files = [writeRunFile(outDir, "docs/prd.md", prd)];
  for (const a of s.adrs) {
    const body = `# ${a.id}: ${a.title}\n\n## Status\nProposed\n\n## Context\n${a.context}\n\n## Decision\n${a.decision}\n\n## Consequences\n${a.consequences}\n`;
    files.push(writeRunFile(outDir, join("docs/adr", `${a.id.slice(4)}-${slugify(a.title)}.md`), body));
  }
  files.push(writeTasksYaml(outDir, s.tasks));
  return { emitted: files, log: [logEntry("planning.emit", { note: `${files.length} files → ${outDir}` })] };
};

// ── routing ─────────────────────────────────────────────────────────────────

export const afterAssess = (s: PlanningState) => (s.briefComplete || s.discoveryRounds >= 2 ? "writeRequirements" : "askQuestions");
export const afterPick = (s: PlanningState) => (s.chosen ? "writeAdrs" : END);
export const afterCoverage = (s: PlanningState) =>
  s.coverage.some((c) => !c.covered) && s.breakdownRounds < 2 ? "breakdown" : "approvePlan";
export const afterPlanGate = (s: PlanningState) => (s.planApproved ? "emit" : END);
