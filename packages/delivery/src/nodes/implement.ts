import {
  adrHeading,
  loadAdrs,
  loadDiff,
  logEntry,
  runDir,
  writeRunFile,
  writingRules,
  type FlowDeps,
  type PriorFinding,
} from "@flows/core";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { agentModel, BASE_TOOLS, ensureWorktree, runClaudeCode, snapshotTree, worktreeDiff } from "../agents/claude-code";
import { replayDiff } from "../agents/diff-file";
import type { DeliveryState, DeliveryUpdate } from "../state";
import { bullets, roundOf, say } from "./shared";

/**
 * Generative. Writes the change in the task's worktree. With the diff-file
 * agent, or offline, it replays a diff; otherwise it runs Claude Code with
 * the prompt from `agentPrompt`. Each attempt adds to the worktree, so a
 * later round fixes the code an earlier one left. The agent's transcript
 * goes to run files, not state.
 *
 * Reads `task`, `plan`, `fixNotes`, `ledger`, `base` and `attempts`. Writes
 * `attempts`, `workdir`, `diff`, `tree`, `agentNote`, and `ledger` entries
 * for notes the agent declined.
 */
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
      const replay = loadDiff(deps.config, s.diffSource);
      const note = `round ${round}, attempt ${attempt}/${max}${addressing} (diff-file)`;
      const done = (update: DeliveryUpdate, extra = "") => ({
        attempts: attempt,
        ...update,
        log: [logEntry("delivery.implement", { note: note + extra, details })],
      });
      if (deps.offline) return done({ diff: replay });
      try {
        // Apply the diff in the task's worktree, so the checks and the merge act on the change.
        const workdir = replayDiff(deps.config.repoDir, deps.config.project, s.task.id, s.base, replay, deps.config.delivery.copyToWorktree);
        return done({ workdir, diff: worktreeDiff(workdir, s.base), tree: snapshotTree(workdir) });
      } catch (e: any) {
        const why = String(e.message).split("\n")[0]!;
        // A diff that doesn't apply has nothing to check: the empty diff sends it to you, with the reason.
        if (why.startsWith("The diff doesn't apply")) return done({ diff: "", agentNote: why }, `: ${why}`);
        // No worktree is possible, for example outside a git repo: checks run in the repo as it is.
        return done({ diff: replay }, `, no worktree (${why}), so checks run in the repo as it is`);
      }
    }

    const workdir = ensureWorktree(deps.config.repoDir, deps.config.project, s.task.id, s.base, deps.config.delivery.copyToWorktree);
    const prompt = agentPrompt(s, deps);

    // The transcript goes to run files, not state. A failed agent run still
    // leaves whatever it changed, so checks and review decide what happens next.
    const tools = deps.config.delivery.agentTools ?? [...BASE_TOOLS, ...deps.config.delivery.checks.map((c) => `Bash(${c})`)];
    const model = agentModel(deps.config.models.implementer, deps.config.claudeCodeModel);
    const dir = runDir(deps.config, s.runId);
    let note = `round ${round}, attempt ${attempt}/${max}${addressing} (claude-code${model ? ` ${model}` : ""})`;
    let declined: PriorFinding[] = [];
    let agentNote: string | undefined;
    try {
      const run = await runClaudeCode(workdir, prompt, tools, model, (step) => say(config, `      ${step}`));
      writeRunFile(dir, `agent-${round}.json`, run.result);
      writeRunFile(dir, `agent-${round}.jsonl`, run.events);
      if (run.costUsd !== undefined) note += `, agent list price $${run.costUsd.toFixed(2)}`;
      agentNote = resultText(run.result);
      declined = parseDeclines(agentNote, s.ledger ?? [], round);
      if (declined.length) note += `, declined ${declined.length}`;
    } catch (e: any) {
      writeRunFile(dir, `agent-${round}.log`, String(e.message));
      note += `: agent failed (${String(e.message).split("\n")[0]})`;
      agentNote = String(e.message);
    }

    const diff = worktreeDiff(workdir, s.base);
    return {
      attempts: attempt,
      workdir,
      diff,
      tree: snapshotTree(workdir),
      agentNote,
      ledger: declined,
      log: [logEntry("delivery.implement", { note, details: [...details, ...declined.map((d) => `declined: ${d.title} — ${d.note}`)] })],
    };
  };

/** The agent's final message, from Claude Code's result event. */
function resultText(resultLine: string): string {
  try {
    return String(JSON.parse(resultLine).result ?? "");
  } catch {
    return "";
  }
}

/**
 * The notes the agent refused, from lines such as
 * "Declined: Move the client under src/lib — ADR-0007 puts it in src/db".
 * Each is matched to the ledger entry it refers to, by title.
 */
export function parseDeclines(text: string, ledger: PriorFinding[], round: number): PriorFinding[] {
  const out: PriorFinding[] = [];
  for (const m of text.matchAll(/^\W*Declined:\s*(.+?)\s+(?:—|–|--|-)\s+(.+)$/gm)) {
    const title = m[1]!.replace(/^\[\w+\]\s*/, "").replace(/[*`]/g, "").trim();
    const reason = m[2]!.trim();
    const sent = [...ledger].reverse().find((p) => p.status === "sent" && sameTitle(p.title, title));
    out.push(
      sent
        ? { ...sent, round, status: "declined", note: reason }
        : { round, reviewer: "unknown", severity: "minor", title, rationale: "", status: "declined", note: reason },
    );
  }
  return out;
}

const sameTitle = (a: string, b: string) => {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b) || norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
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
      ? [
          `This is a follow-up round. The code from earlier rounds is already in place. Fix these, and change nothing else:\n${bullets(s.fixNotes)}`,
          "If a note contradicts an ADR, a project standard, an acceptance criterion or a change an earlier round asked for, don't apply it. " +
            "End your reply with one line per note you didn't apply, in the form `Declined: <note title> — <reason>`. A person will decide.",
        ].join("\n\n")
      : "",
    "Build only what the acceptance criteria, the ADRs and the standards ask for. Add or update tests. Do not commit.",
    `Any documentation or code comments you write follow these rules:\n\n${writingRules("developer")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
