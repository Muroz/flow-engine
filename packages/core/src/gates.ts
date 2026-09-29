/**
 * Human gates. A node that needs you calls LangGraph's `interrupt(request)`;
 * the graph pauses (checkpointed), whoever is driving the run shows you the
 * request, and your decision is fed back with `Command({ resume: decision })`.
 *
 * The request/decision shapes are defined here — framework-free — so any
 * front end can drive them: the CLI today, Slack/iMessage/email tomorrow.
 */
export type GateRequest = {
  gate: string; // "approve-plan", "approve-merge", "escalate", …
  title: string;
  /** One screen, max. If you need to scroll, the node is asking too much of you. */
  summary: string;
  /** Allowed decisions; the first one is the default for --yes. */
  options: string[];
  /** Optional path to a longer artifact (report, diff) for when you do want detail. */
  detailPath?: string;
};

export type GateDecision = {
  decision: string;
  notes?: string;
};
