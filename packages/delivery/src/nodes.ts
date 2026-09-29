/**
 * Delivery nodes.
 *
 *   makePlan      generative   short implementation plan for the task
 *   assessRisk    judge        low/medium/high → decides whether you see the plan
 *   approvePlan   human gate   only when risk is above the auto-approve bar
 *   implement     generative   replays a diff, or runs Claude Code in a worktree
 *   runChecks     deterministic tests/lint/typecheck from .flows.yaml, in the worktree
 *   runReview     subgraph     the review flow, with explicit state mapping
 *   escalate      human gate   stop rule hit, or the reviewer wants a human
 *   approveMerge  human gate   you approve outcome, not process
 */
import { execSync } from "node:child_process";
import {
  loadAdrs,
  loadDiff,
  loadPrompt,
  logEntry,
  modelFor,
  parseJsonReply,
  render,
  runDir,
  score,
  writeRunFile,
  type FlowDeps,
  type GateDecision,
  type GateRequest,
  type Risk,
} from "@flows/core";
import { rank, type ReviewGraph, type ReviewState } from "@flows/review";
import { END, interrupt } from "@langchain/langgraph";
import { BASE_TOOLS, ensureWorktree, runClaudeCode, worktreeDiff } from "./agents/claude-code";
import type { DeliveryState, DeliveryUpdate } from "./state";

const RISKS: readonly Risk[] = ["low", "medium", "high"];
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

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
      }),
    });
    const p = parseJsonReply<{ summary?: string; steps?: string[] }>(res.text, {});
    return {
      plan: { summary: p.summary ?? "", steps: p.steps ?? [], risk: s.task.risk },
      log: [logEntry("delivery.plan", { model: res.model, costUsd: res.costUsd })],
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
    summary: `${s.plan!.summary}\n\n${bullets(s.plan!.steps)}`,
    options: ["approve", "reject"],
  });
  return d.decision === "approve"
    ? { fixNotes: d.notes ? [d.notes] : [], log: [logEntry("delivery.approvePlan", { note: "approved" })] }
    : { outcome: "rejected", log: [logEntry("delivery.approvePlan", { note: `rejected: ${d.notes ?? ""}` })] };
};

// ── implement ───────────────────────────────────────────────────────────────

export const implement =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const attempt = s.attempts + 1;
    const addressing = s.fixNotes.length ? ` addressing ${s.fixNotes.length} note(s)` : "";

    // Offline runs always replay the diff: the mocks don't write code.
    if (deps.offline || deps.config.delivery.agent === "diff-file") {
      return {
        attempts: attempt,
        diff: loadDiff(deps.config, s.diffSource),
        log: [logEntry("delivery.implement", { note: `attempt ${attempt}${addressing} (diff-file)` })],
      };
    }

    const workdir = ensureWorktree(deps.config.repoDir, deps.config.project, s.task.id, s.base);
    const adrs = loadAdrs(deps.config, s.task.adrRefs);
    const prompt = [
      `Implement ${s.task.id}: ${s.task.title}`,
      `Acceptance criteria:\n${bullets(s.task.acceptanceCriteria)}`,
      `Plan:\n${bullets(s.plan?.steps ?? [])}`,
      adrs.length ? `Decisions to respect:\n${adrs.map((a) => `${a.id}: ${a.title}\n${a.decision}`).join("\n\n")}` : "",
      deps.config.conventions.length ? `Conventions:\n${bullets(deps.config.conventions)}` : "",
      s.fixNotes.length ? `Fix these from the last attempt:\n${bullets(s.fixNotes)}` : "",
      "Add or update tests. Do not commit.",
    ]
      .filter(Boolean)
      .join("\n\n");

    // The transcript goes to a run file, not state. A failed agent run still
    // leaves whatever it changed, so checks and review decide what happens next.
    const tools = deps.config.delivery.agentTools ?? [...BASE_TOOLS, ...deps.config.delivery.checks.map((c) => `Bash(${c})`)];
    let note = `attempt ${attempt}${addressing} (claude-code)`;
    try {
      const transcript = runClaudeCode(workdir, prompt, tools);
      writeRunFile(runDir(deps.config, s.runId), `agent-attempt-${attempt}.json`, transcript);
    } catch (e: any) {
      writeRunFile(runDir(deps.config, s.runId), `agent-attempt-${attempt}.log`, `${e.message}\n${e.stdout ?? ""}${e.stderr ?? ""}`);
      note += `: agent failed (${String(e.message).split("\n")[0]})`;
    }

    return {
      attempts: attempt,
      workdir,
      diff: worktreeDiff(workdir, s.base),
      log: [logEntry("delivery.implement", { note })],
    };
  };

// ── checks ──────────────────────────────────────────────────────────────────

export const runChecks =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const cmds = deps.config.delivery.checks;
    if (deps.offline || cmds.length === 0) {
      return { checks: { passed: true, output: "skipped" }, log: [logEntry("delivery.checks", { note: "skipped" })] };
    }
    for (const cmd of cmds) {
      try {
        execSync(cmd, { cwd: s.workdir ?? deps.config.repoDir, stdio: "pipe", timeout: 10 * 60_000 });
      } catch (e: any) {
        const output = `${cmd} failed:\n${String(e.stdout ?? "")}${String(e.stderr ?? "")}`.slice(-2000);
        return {
          checks: { passed: false, output },
          fixNotes: [output],
          log: [logEntry("delivery.checks", { note: `failed: ${cmd}` })],
        };
      }
    }
    return { checks: { passed: true, output: "ok" }, log: [logEntry("delivery.checks", { note: `${cmds.length} passed` })] };
  };

// ── review (subgraph) ───────────────────────────────────────────────────────

/**
 * The review flow runs as a subgraph. The mapping in and out is explicit on
 * purpose: review sees the diff and the task — not the plan, the fix history
 * or the checks output — and delivery gets back only the verdict and findings.
 */
export const review =
  (reviewGraph: ReviewGraph) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const out = (await reviewGraph.invoke({
      input: { diff: s.diff ?? "", task: s.task, label: `${s.task.id} attempt ${s.attempts}` },
    })) as ReviewState;

    const kept = (out.findings ?? []).filter((f) => f.kept).sort((a, b) => rank(b.judgedSeverity) - rank(a.judgedSeverity));
    return {
      review: { verdict: out.verdict ?? "escalate", reason: out.verdictReason ?? "", findings: kept, report: out.report ?? "" },
      fixNotes: kept.map((f) => `[${f.judgedSeverity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`),
      log: [...out.log, logEntry("delivery.review", { note: `${out.verdict}: ${out.verdictReason}` })],
    };
  };

// ── escalate & merge gates ──────────────────────────────────────────────────

export const escalate =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const hitLimit = s.attempts >= deps.config.delivery.maxAttempts;
    const why = hitLimit
      ? `Stop rule: ${s.attempts} attempts and still not passing.`
      : `Reviewer escalated: ${s.review?.reason ?? s.checks?.output ?? "unknown"}`;
    const d = gate({
      gate: "escalate",
      title: `${s.task.id} needs you`,
      summary: `${why}\n\nOpen issues:\n${bullets(s.fixNotes.slice(0, 8))}`,
      options: ["abort", "retry", "accept"],
    });
    if (d.decision === "retry") {
      return { attempts: 0, fixNotes: [...s.fixNotes, ...(d.notes ? [d.notes] : [])], log: [logEntry("delivery.escalate", { note: "retry" })] };
    }
    if (d.decision === "accept") return { log: [logEntry("delivery.escalate", { note: "accepted as-is" })] };
    return { outcome: "escalated", log: [logEntry("delivery.escalate", { note: "aborted" })] };
  };

export const approveMerge = async (s: DeliveryState): Promise<DeliveryUpdate> => {
  const d = gate({
    gate: "approve-merge",
    title: `Merge ${s.task.id}?`,
    summary: [
      `${s.task.title} — ${s.attempts} attempt(s)`,
      `checks: ${s.checks ? (s.checks.passed ? "passing" : "failing") : "not run"} · review: ${s.review?.verdict ?? "not run"} (${s.review?.reason ?? ""})`,
      ...(s.workdir ? [`branch: flows/${s.task.id} in ${s.workdir}`] : []),
      ...(s.review?.findings.length ? ["", "Non-blocking comments:", bullets(s.fixNotes.slice(0, 6))] : []),
    ].join("\n"),
    options: ["merge", "reject"],
  });
  // Pushing and opening the PR stay with you (see docs/wiring.md, step 5).
  return {
    outcome: d.decision === "merge" ? "merged" : "rejected",
    log: [logEntry("delivery.approveMerge", { note: d.decision })],
  };
};

// ── routing (conditional edges) ─────────────────────────────────────────────

const riskRank = (r: string) => ["none", "low", "medium", "high"].indexOf(r);

export const afterRisk = (deps: FlowDeps) => (s: DeliveryState) =>
  riskRank(s.plan!.risk) <= riskRank(deps.config.delivery.autoApproveRisk) ? "implement" : "approvePlan";

export const afterPlanGate = (s: DeliveryState) => (s.outcome === "rejected" ? END : "implement");

export const afterChecks = (deps: FlowDeps) => (s: DeliveryState) => {
  if (s.checks?.passed) return "runReview";
  return s.attempts < deps.config.delivery.maxAttempts ? "implement" : "escalate";
};

export const afterReview = (deps: FlowDeps) => (s: DeliveryState) => {
  const v = s.review?.verdict;
  if (v === "pass") return "approveMerge";
  if (v === "fix" && s.attempts < deps.config.delivery.maxAttempts) return "implement";
  return "escalate";
};

export const afterEscalate = (s: DeliveryState) => {
  if (s.outcome) return END;
  return s.attempts === 0 ? "implement" : "approveMerge"; // retry resets attempts; accept goes to merge
};
