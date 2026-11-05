import { logEntry, totalCost, type FlowDeps, type TriagedFinding } from "@flows/core";
import { rank } from "@flows/review";
import type { DeliveryState, DeliveryUpdate } from "../state";
import { findingNote, openItems } from "./review";
import { gate, overBudget, spentSince } from "./shared";

/** One line per review round so far, such as "round 2: fix, 2 major/blocker finding(s)". */
export function roundHistory(s: DeliveryState): string[] {
  return s.log.filter((e) => e.node === "delivery.review").map((e, i) => `round ${i + 1}: ${e.note ?? ""}`);
}

/** A major or blocker finding. */
const blocking = (f: TriagedFinding) => rank(f.judgedSeverity) >= rank("major");

/**
 * Human gate, open when the run is stuck: the agent changed nothing, the cost
 * limit is spent, the attempts are used up, or the reviewer asked for a
 * person. retry gives `delivery.retryAttempts` more attempts, resets the
 * cost limit and passes your notes to the agent; accept goes on to the
 * walkthrough; abort ends the run.
 *
 * Reads `diff`, `review`, `checks`, `ledger`, `attempts` and `log`. Writes
 * `escalation`, `attempts`, `budgetFrom` and `fixNotes`, or `outcome`.
 */
export const escalate =
  (deps: FlowDeps) =>
  async (s: DeliveryState): Promise<DeliveryUpdate> => {
    const { maxAttempts, maxCostUsd, retryAttempts } = deps.config.delivery;
    const spent = spentSince(s);
    const empty = !s.diff?.trim();
    const why = empty
      ? "The agent changed nothing. Its last message:"
      : overBudget(deps, s)
      ? `Cost limit: $${spent.toFixed(2)} spent, limit $${maxCostUsd.toFixed(2)} (delivery.maxCostUsd).`
      : s.attempts >= maxAttempts
        ? `Out of attempts: ${s.attempts} of ${maxAttempts} used and still not passing.`
        : `The reviewer wants a person to look: ${s.review?.reason ?? "unknown"}`;
    const findings = s.review?.findings ?? [];
    const open = openItems(s.ledger ?? []);
    const failedCheck = s.checks && !s.checks.passed ? s.checks.results.find((r) => r.status === "failed") : undefined;
    const d = gate({
      gate: "escalate",
      title: `${s.task.id} needs you`,
      detailPath: s.review?.reportPath,
      summary: [
        why,
        ...(empty ? (s.agentNote?.trim() || "(none)").split("\n").slice(0, 15).map((l) => `  ${l}`) : []),
        "",
        "History:",
        ...roundHistory(s).map((h) => `  ${h}`),
        ...(failedCheck ? ["", `Last checks: ${failedCheck.command} failed`, ...s.checks!.output.split("\n").slice(-6).map((l) => `  ${l}`)] : []),
        "",
        `Still open (${findings.filter(blocking).length} blocking, ${findings.filter((f) => !blocking(f)).length} minor):`,
        ...findings.slice(0, 8).map((f) => `  ${findingNote(f)}`),
        ...(open.length ? ["", "For you to decide (add your call as a note on retry):", ...open.map((o) => `  ${o}`)] : []),
        "",
        `retry gives ${retryAttempts} more attempt(s) and resets the cost limit. Notes you add go to the agent.`,
      ].join("\n"),
      // An empty diff has nothing to accept.
      options: empty ? ["abort", "retry"] : ["abort", "retry", "accept"],
    });
    if (d.decision === "retry") {
      return {
        escalation: "retry",
        attempts: Math.max(0, maxAttempts - retryAttempts),
        budgetFrom: totalCost(s.log),
        fixNotes: [...s.fixNotes, ...(d.notes ? [d.notes] : [])],
        log: [logEntry("delivery.escalate", { note: "retry" })],
      };
    }
    if (d.decision === "accept") return { escalation: "accept", log: [logEntry("delivery.escalate", { note: "accepted as-is" })] };
    return { outcome: "escalated", log: [logEntry("delivery.escalate", { note: "aborted" })] };
  };
