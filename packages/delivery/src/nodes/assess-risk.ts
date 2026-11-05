import { logEntry, score, type FlowDeps, type Risk } from "@flows/core";
import type { DeliveryState, DeliveryUpdate } from "../state";

const RISKS: readonly Risk[] = ["low", "medium", "high"];

/**
 * Judge. How risky the plan is to run without a person reading it first.
 * The result never goes below the risk planning gave the task, and decides
 * whether the plan gate opens.
 *
 * Reads `task` and `plan`. Writes `plan.risk`.
 */
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
