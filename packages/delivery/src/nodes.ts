/**
 * Delivery nodes.
 *
 *   makePlan      generative   short implementation plan for the task
 *   assessRisk    judge        low/medium/high → decides whether you see the plan
 *   approvePlan   human gate   only when risk is above the auto-approve bar
 *   implement     generative   replays a diff, or runs Claude Code in a worktree
 *   runChecks     deterministic tests/lint/typecheck from .flows.yaml, in the worktree
 *   runReview     subgraph     the review flow, with explicit state mapping
 *   escalate      human gate   out of attempts, over budget, or the reviewer wants a human
 *   explainWork   generative   plain-language walkthrough
 *   approveMerge  human gate   you approve outcome, not process, or send comments back
 */
import { spawn } from "node:child_process";
import {
  adrHeading,
  loadAdrs,
  loadDiff,
  loadPrompt,
  logEntry,
  modelFor,
  parseJsonReply,
  render,
  writingRules,
  runDir,
  score,
  totalCost,
  writeRunFile,
  type FlowDeps,
  type GateDecision,
  type GateRequest,
  type Risk,
  type TriagedFinding,
} from "@flows/core";
import { rank, type ReviewGraph, type ReviewState } from "@flows/review";
import { END, interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { agentModel, BASE_TOOLS, ensureWorktree, runClaudeCode, worktreeDiff } from "./agents/claude-code";
import type { CheckResult, DeliveryState, DeliveryUpdate } from "./state";
import { appendJournal, writeWalkthrough } from "./walkthrough";

const RISKS: readonly Risk[] = ["low", "medium", "high"];
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

/** Sends a live line to the CLI while a node runs. */
const say = (config: LangGraphRunnableConfig | undefined, line: string) => config?.writer?.({ line });

/** Counts implement runs across retries, so each round's files get their own name. */
const roundOf = (s: DeliveryState) => s.log.filter((e) => e.node === "delivery.implement").length;

export const spentSince = (s: DeliveryState) => totalCost(s.log) - s.budgetFrom;
export const overBudget = (deps: FlowDeps, s: DeliveryState) =>
  deps.config.delivery.maxCostUsd > 0 && spentSince(s) >= deps.config.delivery.maxCostUsd;

/** Pause the graph and hand a GateRequest to whoever is driving it. */
function gate(req: GateRequest): GateDecision {
  return interrupt(req) as GateDecision;
}

// ── plan & risk ─────────────────────────────────────────────────────────────

export const makePlan =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const res = await deps.model.complete({
      tag: "delivery.plan",
      model: modelFor(deps.config, "planner"),
      json: true,
      system: "You are a senior engineer writing a short implementation plan for one task.",
      user: render(loadPrompt("delivery/plan"), {
        task: `${s.task.id}: ${s.task.title}`,
        acceptance_criteria: bullets(s.task.acceptanceCriteria),
        adrs: s.task.adrRefs.join(", ") || "(none)",
        feedback: s.planFeedback && s.plan ? `${s.plan.summary}\n${bullets(s.plan.steps)}\n\nNotes: ${s.planFeedback}` : "(none)",
      }),
    });
    const p = parseJsonReply<{ summary?: string; steps?: string[] }>(res.text, {});
    return {
      plan: { summary: p.summary ?? "", steps: p.steps ?? [], risk: s.task.risk },
      planFeedback: undefined,
      log: [logEntry("delivery.plan", { model: res.model, costUsd: res.costUsd, note: `${p.steps?.length ?? 0} steps` })],
    };
  };

export const assessRisk =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const a = await deps.judge.ask(
      { task: s.task, plan: s.plan },
      {
        risk: score(
          "How risky is executing this plan without a human reading it first? Consider data migrations, auth, payments, public API changes and irreversible operations.",
          RISKS,
        ),
      },
    );
    // Never go below the risk the planning flow assigned.
    const risk = RISKS[Math.max(RISKS.indexOf(s.task.risk), a.risk.index)]!;
    return {
      plan: { ...s.plan!, risk },
      log: [logEntry("delivery.assessRisk", { note: `${deps.judge.name}: ${a.risk.level} → ${risk}` })],
    };
  };

export const approvePlan = async (s: DeliveryState): Promise<DeliveryUpdate> => {
  const d = gate({
    gate: "approve-plan",
    title: `Approve plan for ${s.task.id} (${s.plan!.risk} risk)`,
    summary: [
      s.plan!.summary,
      "",
      ...s.plan!.steps.map((step, i) => `${i + 1}. ${step}`),
      "",
      `Acceptance criteria (${s.task.acceptanceCriteria.length}):`,
      ...s.task.acceptanceCriteria.map((c) => `  - ${c}`),
    ].join("\n"),
    options: ["approve", "revise", "reject"],
  });
  const log = [logEntry("delivery.approvePlan", { note: d.decision })];
  if (d.decision === "revise") return { planFeedback: d.notes, log };
  return d.decision === "approve" ? { fixNotes: d.notes ? [d.notes] : [], log } : { outcome: "rejected", log };
};

// ── implement ───────────────────────────────────────────────────────────────

export const implement =
  (deps: FlowDeps) =>
  async (s: DeliveryState, config?: LangGraphRunnableConfig): Promise<DeliveryUpdate> => {
    const attempt = s.attempts + 1;
    const round = roundOf(s) + 1;
    const max = deps.config.delivery.maxAttempts;
    const addressing = s.fixNotes.length ? `, addressing ${s.fixNotes.length} note(s)` : "";
    const details = s.fixNotes.map((n) => `addressing: ${n.split("\n")[0]}`);

    // Offline runs always replay the diff: the mocks don't write code.
    if (deps.offline || deps.config.delivery.agent === "diff-file") {
      return {
        attempts: attempt,
        diff: loadDiff(deps.config, s.diffSource),
        log: [logEntry("delivery.implement", { note: `round ${round}, attempt ${attempt}/${max}${addressing} (diff-file)`, details })],
      };
    }

    const workdir = ensureWorktree(deps.config.repoDir, deps.config.project, s.task.id, s.base);
    const prompt = agentPrompt(s, deps);

    // The transcript goes to run files, not state. A failed agent run still
    // leaves whatever it changed, so checks and review decide what happens next.
    const tools = deps.config.delivery.agentTools ?? [...BASE_TOOLS, ...deps.config.delivery.checks.map((c) => `Bash(${c})`)];
    const model = agentModel(deps.config.models.implementer, deps.config.claudeCodeModel);
    const dir = runDir(deps.config, s.runId);
    let note = `round ${round}, attempt ${attempt}/${max}${addressing} (claude-code${model ? ` ${model}` : ""})`;
    try {
      const run = await runClaudeCode(workdir, prompt, tools, model, (step) => say(config, `      ${step}`));
      writeRunFile(dir, `agent-${round}.json`, run.result);
      writeRunFile(dir, `agent-${round}.jsonl`, run.events);
      if (run.costUsd !== undefined) note += `, agent list price $${run.costUsd.toFixed(2)}`;
    } catch (e: any) {
      writeRunFile(dir, `agent-${round}.log`, String(e.message));
      note += `: agent failed (${String(e.message).split("\n")[0]})`;
    }

    return {
      attempts: attempt,
      workdir,
      diff: worktreeDiff(workdir, s.base),
      log: [logEntry("delivery.implement", { note, details })],
    };
  };

/** What the coding agent is told for one attempt. */
export function agentPrompt(s: DeliveryState, deps: FlowDeps): string {
  const adrs = loadAdrs(deps.config, s.task.adrRefs);
  const standards = deps.config.standards.map((ref) => ref.path);
  return [
    `Implement ${s.task.id}: ${s.task.title}`,
    `Acceptance criteria:\n${bullets(s.task.acceptanceCriteria)}`,
    `Plan:\n${bullets(s.plan?.steps ?? [])}`,
    standards.length ? `Read these project standards before you start, and follow them. Reviewers check against them:\n${bullets(standards)}` : "",
    adrs.length ? `Decisions to respect:\n${adrs.map((a) => `${adrHeading(a)}\n${a.decision}`).join("\n\n")}` : "",
    deps.config.conventions.length ? `Conventions:\n${bullets(deps.config.conventions)}` : "",
    s.fixNotes.length
      ? `This is a follow-up round. The code from earlier rounds is already in place. Fix only these, and change nothing else:\n${bullets(s.fixNotes)}`
      : "",
    "Build only what the acceptance criteria, the ADRs and the standards ask for. Add or update tests. Do not commit.",
    `Any documentation or code comments you write follow these rules:\n\n${writingRules("developer")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── checks ──────────────────────────────────────────────────────────────────

export const runChecks =
  (deps: FlowDeps) =>
  async (s: DeliveryState, config?: LangGraphRunnableConfig): Promise<DeliveryUpdate> => {
    const cmds = deps.config.delivery.checks;
    if (deps.offline || cmds.length === 0) {
      return { checks: { passed: true, output: "skipped", results: [] }, log: [logEntry("delivery.checks", { note: "skipped" })] };
    }
    const results: CheckResult[] = [];
    let failure: string | undefined;
    for (const command of cmds) {
      if (failure) {
        results.push({ command, status: "not run", seconds: 0 });
        continue;
      }
      say(config, `      running ${command}`);
      const started = Date.now();
      const { code, output } = await runCommand(command, s.workdir ?? deps.config.repoDir);
      const seconds = (Date.now() - started) / 1000;
      results.push({ command, status: code === 0 ? "passed" : "failed", seconds });
      if (code !== 0) failure = `${command} failed:\n${output.slice(-2000)}`;
    }
    const passed = !failure;
    return {
      checks: { passed, output: failure ?? "ok", results },
      ...(failure ? { fixNotes: [failure] } : {}),
      log: [
        logEntry("delivery.checks", {
          note: passed ? `${cmds.length} passed` : `failed: ${results.find((r) => r.status === "failed")!.command}`,
          details: results.map(describeCheck),
        }),
      ],
    };
  };

export const describeCheck = (r: CheckResult) =>
  `${{ passed: "✓", failed: "✗", "not run": "·" }[r.status]} ${r.command}${r.status === "not run" ? " (not run)" : ` (${r.seconds.toFixed(1)}s)`}`;

function runCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (e) => resolve({ code: 1, output: String(e) }));
  });
}

// ── review (subgraph) ───────────────────────────────────────────────────────

/** A review finding as a note for the agent, with the reviewer's reason. */
export function findingNote(f: TriagedFinding): string {
  const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  const why = f.rationale ? `: ${f.rationale.split(/(?<=\.)\s/)[0]}` : "";
  return `[${f.judgedSeverity}] ${f.title}${where}${why}`;
}

/**
 * The review flow runs as a subgraph. The mapping in and out is explicit on
 * purpose: review sees the diff and the task — not the plan, the fix history
 * or the checks output — and delivery gets back only the verdict and findings.
 */
export const review =
  (deps: FlowDeps, reviewGraph: ReviewGraph) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const round = roundOf(s);
    const out = (await reviewGraph.invoke({
      input: { diff: s.diff ?? "", task: s.task, label: `${s.task.id} round ${round}` },
    })) as ReviewState;

    const kept = (out.findings ?? []).filter((f) => f.kept).sort((a, b) => rank(b.judgedSeverity) - rank(a.judgedSeverity));
    const reportPath = writeRunFile(runDir(deps.config, s.runId), `review-${round}.md`, out.report ?? "");
    return {
      review: { verdict: out.verdict ?? "escalate", reason: out.verdictReason ?? "", findings: kept, report: out.report ?? "", reportPath },
      fixNotes: kept.map(findingNote),
      log: [
        ...out.log,
        logEntry("delivery.review", {
          note: `${out.verdict}: ${out.verdictReason}`,
          details: kept.map((f) => `[${f.judgedSeverity}] ${f.title}${f.file ? ` (${f.file})` : ""}`),
        }),
      ],
    };
  };

// ── escalate & merge gates ──────────────────────────────────────────────────

/** One line per review round so far, such as "round 2: fix, 2 major/blocker finding(s)". */
export function roundHistory(s: DeliveryState): string[] {
  return s.log.filter((e) => e.node === "delivery.review").map((e, i) => `round ${i + 1}: ${e.note ?? ""}`);
}

const blocking = (f: TriagedFinding) => rank(f.judgedSeverity) >= rank("major");

export const escalate =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const { maxAttempts, maxCostUsd, retryAttempts } = deps.config.delivery;
    const spent = spentSince(s);
    const why = overBudget(deps, s)
      ? `Cost limit: $${spent.toFixed(2)} spent, limit $${maxCostUsd.toFixed(2)} (delivery.maxCostUsd).`
      : s.attempts >= maxAttempts
        ? `Out of attempts: ${s.attempts} of ${maxAttempts} used and still not passing.`
        : `The reviewer wants a person to look: ${s.review?.reason ?? "unknown"}`;
    const findings = s.review?.findings ?? [];
    const failedCheck = s.checks && !s.checks.passed ? s.checks.results.find((r) => r.status === "failed") : undefined;
    const d = gate({
      gate: "escalate",
      title: `${s.task.id} needs you`,
      detailPath: s.review?.reportPath,
      summary: [
        why,
        "",
        "History:",
        ...roundHistory(s).map((h) => `  ${h}`),
        ...(failedCheck ? ["", `Last checks: ${failedCheck.command} failed`, ...s.checks!.output.split("\n").slice(-6).map((l) => `  ${l}`)] : []),
        "",
        `Still open (${findings.filter(blocking).length} blocking, ${findings.filter((f) => !blocking(f)).length} minor):`,
        ...findings.slice(0, 8).map((f) => `  ${findingNote(f)}`),
        "",
        `retry gives ${retryAttempts} more attempt(s) and resets the cost limit. Notes you add go to the agent.`,
      ].join("\n"),
      options: ["abort", "retry", "accept"],
    });
    if (d.decision === "retry") {
      return {
        attempts: Math.max(0, maxAttempts - retryAttempts),
        budgetFrom: totalCost(s.log),
        fixNotes: [...s.fixNotes, ...(d.notes ? [d.notes] : [])],
        log: [logEntry("delivery.escalate", { note: "retry" })],
      };
    }
    if (d.decision === "accept") return { log: [logEntry("delivery.escalate", { note: "accepted as-is" })] };
    return { outcome: "escalated", log: [logEntry("delivery.escalate", { note: "aborted" })] };
  };

// ── walkthrough ─────────────────────────────────────────────────────────────

export const explainWork =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const { walkthrough, log } = await writeWalkthrough(deps, {
      task: s.task,
      diff: s.diff ?? "",
      runId: s.runId,
      plan: s.plan,
      review: s.review,
    });
    return { walkthrough, log: [log] };
  };

/**
 * Which open comments a "fix" at the merge gate sends back. No notes: all of
 * them. Leading numbers, such as "1,3: also rename the helper": those, plus
 * the text. Text alone: just the text.
 */
export function pickComments(comments: string[], notes: string | undefined): string[] {
  const text = (notes ?? "").trim();
  if (!text) return comments;
  const m = text.match(/^([\d,\s]+)(?::\s*([\s\S]*))?$/) ?? text.match(/^([\d,\s]+):\s*([\s\S]*)$/);
  if (!m) return [text];
  const picked = m[1]!.split(/[,\s]+/).filter(Boolean).map((n) => comments[Number(n) - 1]).filter((c): c is string => !!c);
  return m[2]?.trim() ? [...picked, m[2].trim()] : picked;
}

export const approveMerge =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const comments = (s.review?.findings ?? []).map(findingNote);
    const d = gate({
      gate: "approve-merge",
      title: `Merge ${s.task.id}?`,
      detailPath: s.walkthrough?.path,
      summary: [
        ...(s.walkthrough?.gist ? [s.walkthrough.gist, ""] : []),
        `${s.task.title}: ${roundOf(s)} round(s), $${totalCost(s.log).toFixed(2)} in model calls`,
        `Checks: ${s.checks?.results.length ? s.checks.results.map(describeCheck).join("  ") : s.checks ? "skipped" : "not run"}`,
        `Review: ${s.review?.verdict ?? "not run"} (${s.review?.reason ?? ""})`,
        ...(s.workdir ? [`Branch: flows/${s.task.id} in ${s.workdir}`] : []),
        ...(comments.length ? ["", "Open review comments:", ...comments.map((c, i) => `  ${i + 1}. ${c}`)] : []),
        ...(comments.length
          ? ["", `fix sends comments back for ${deps.config.delivery.retryAttempts} more attempt(s): no notes for all, "1,3" for some, or your own text.`]
          : []),
      ].join("\n"),
      options: comments.length ? ["merge", "fix", "reject"] : ["merge", "reject"],
    });
    if (d.decision === "fix") {
      return {
        attempts: Math.max(0, deps.config.delivery.maxAttempts - deps.config.delivery.retryAttempts),
        budgetFrom: totalCost(s.log),
        fixNotes: pickComments(comments, d.notes),
        walkthrough: undefined,
        log: [logEntry("delivery.approveMerge", { note: "fix" })],
      };
    }
    // Pushing and opening the PR stay with you (see docs/wiring.md, step 5).
    const merged = d.decision === "merge";
    const journal = merged && s.walkthrough && !deps.offline ? appendJournal(deps, s.task, s.walkthrough, s.runId) : undefined;
    return {
      outcome: merged ? "merged" : "rejected",
      log: [logEntry("delivery.approveMerge", { note: journal ? `${d.decision}, journal updated` : d.decision })],
    };
  };

// ── routing (conditional edges) ─────────────────────────────────────────────

const riskRank = (r: string) => ["none", "low", "medium", "high"].indexOf(r);

export const afterRisk = (deps: FlowDeps) => (s: DeliveryState) =>
  riskRank(s.plan!.risk) <= riskRank(deps.config.delivery.autoApproveRisk) ? "implement" : "approvePlan";

export const afterPlanGate = (s: DeliveryState) => (s.outcome === "rejected" ? END : s.planFeedback ? "makePlan" : "implement");

export const afterChecks = (deps: FlowDeps) => (s: DeliveryState) => {
  if (s.checks?.passed) return "runReview";
  return s.attempts < deps.config.delivery.maxAttempts && !overBudget(deps, s) ? "implement" : "escalate";
};

export const afterReview = (deps: FlowDeps) => (s: DeliveryState) => {
  const v = s.review?.verdict;
  if (v === "pass") return "explainWork";
  if (v === "fix" && s.attempts < deps.config.delivery.maxAttempts && !overBudget(deps, s)) return "implement";
  return "escalate";
};

export const afterEscalate = (deps: FlowDeps) => (s: DeliveryState) => {
  if (s.outcome) return END;
  // retry lowers attempts below the limit; accept leaves them at it.
  return s.attempts < deps.config.delivery.maxAttempts ? "implement" : "explainWork";
};

export const afterMerge = (s: DeliveryState) => (s.outcome ? END : "implement");
