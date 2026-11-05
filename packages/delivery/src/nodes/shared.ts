/** Helpers that more than one delivery node, or the routing, uses. */
import { totalCost, type FlowDeps, type GateDecision, type GateRequest } from "@flows/core";
import { interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { DeliveryState } from "../state";

/** A Markdown bullet list, one item per line. */
export const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

/** Sends a live line to the CLI while a node runs. */
export const say = (config: LangGraphRunnableConfig | undefined, line: string) => config?.writer?.({ line });

/** Counts implement runs across retries, so each round's files get their own name. */
export const roundOf = (s: DeliveryState) => s.log.filter((e) => e.node === "delivery.implement").length;

/** Model spend since the last reset: the start of the run, or your last retry or fix. */
export const spentSince = (s: DeliveryState) => totalCost(s.log) - s.budgetFrom;

/** True when `delivery.maxCostUsd` is set and the spend since the last reset has reached it. */
export const overBudget = (deps: FlowDeps, s: DeliveryState) =>
  deps.config.delivery.maxCostUsd > 0 && spentSince(s) >= deps.config.delivery.maxCostUsd;

/** Pause the graph and hand a GateRequest to whoever is driving it. */
export function gate(req: GateRequest): GateDecision {
  return interrupt(req) as GateDecision;
}
