/**
 * Delivery nodes.
 *
 *   makePlan      generative   short implementation plan for the task
 *   assessRisk    judge        low/medium/high → decides whether you see the plan
 *   approvePlan   human gate   only when risk is above the auto-approve bar
 *   implement     generative   STUB — plug in your coding agent here
 *   runChecks     deterministic tests/lint/typecheck from .flows.yaml
 *   review        subgraph     the review flow, with explicit state mapping
 *   escalate      human gate   stop rule hit, or the reviewer wants a human
 *   approveMerge  human gate   you approve outcome, not process
 */
import { execSync } from "node:child_process";
import {
  loadDiff,
  loadPrompt,
  logEntry,
  modelFor,
  parseJsonReply,
  render,
  score,
  type FlowDeps,
  type GateDecision,
  type GateRequest,
  type Risk,
} from "@flows/core";
import { rank, type ReviewGraph, type ReviewState } from "@flows/review";
import { END, interrupt } from "@langchain/langgraph";
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

// ── implement (STUB) ────────────────────────────────────────────────────────

export const implement =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    // ── Plug your coding agent in here ──────────────────────────────────────
    // Typical shape: create a git worktree/branch for the task, then run a
    // coding agent headless with the task, plan and fixNotes as its prompt, e.g.
    //
    //   claude -p "$PROMPT" --output-format json --permission-mode acceptEdits
    //
    // and read the resulting diff back with `git diff main...<branch>`.
    // Keep the agent's own transcript OUT of state: store it as a run file
    // and put only the diff (a reference would be even better) in state.
    //
    // Demo behaviour: use the diff given on the command line.
    const diff = loadDiff(deps.config, s.diffSource);
    return {
      attempts: s.attempts + 1,
      diff,
      log: [
        logEntry("delivery.implement", {
          note: `attempt ${s.attempts + 1}${s.fixNotes.length ? ` addressing ${s.fixNotes.length} note(s)` : ""} (stub)`,
        }),
      ],
    };
  };

// ── checks ──────────────────────────────────────────────────────────────────

export const runChecks =
  (deps: FlowDeps) =>
  async (_s: DeliveryState): Promise<DeliveryUpdate> => {
    const cmds = deps.config.delivery.checks;
    if (deps.offline || cmds.length === 0) {
      return { checks: { passed: true, output: "skipped" }, log: [logEntry("delivery.checks", { note: "skipped" })] };
    }
    for (const cmd of cmds) {
      try {
        execSync(cmd, { cwd: deps.config.repoDir, stdio: "pipe", timeout: 10 * 60_000 });
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
      `checks: ${s.checks?.passed ? "passing" : "not run"} · review: ${s.review?.verdict} (${s.review?.reason})`,
      ...(s.review?.findings.length ? ["", "Non-blocking comments:", bullets(s.fixNotes.slice(0, 6))] : []),
    ].join("\n"),
    options: ["merge", "reject"],
  });
  // STUB: open/merge the PR here (e.g. `gh pr create --fill` then `gh pr merge`).
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
