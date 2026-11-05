/** Helpers that more than one planning node uses. */
import type { GateDecision, GateRequest } from "@flows/core";
import { interrupt } from "@langchain/langgraph";
import type { Requirement } from "../state";

/** Pause the graph and hand a GateRequest to whoever is driving it. */
export const gate = (req: GateRequest) => interrupt(req) as GateDecision;

/** A Markdown bullet list, one item per line. */
export const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

/** Requirements as `- R-1: text` lines, the form the prompts use. */
export const reqList = (rs: Requirement[]) => rs.map((r) => `- ${r.id}: ${r.text}`).join("\n");
