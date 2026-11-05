/**
 * Review nodes, one file each. Every node is `(state) => Partial<state>`;
 * dependencies come in through `deps`. Node kinds, in order:
 *
 *   loadContext   deterministic  read diff, task, ADRs, conventions
 *   reviewer      generative     one specialist, run N times in parallel
 *   aggregate     deterministic  de-duplicate across specialists
 *   verify        generative     is each finding valid, or does it conflict with a rule or an earlier round?
 *   triage        judge          how severe is each valid finding?
 *   decide        deterministic  pass / fix / escalate from the triaged list
 *   report        deterministic  one-screen digest for you
 *
 * The only conditional edge, the reviewer fan-out, lives in graph.ts because
 * it needs the reviewer registry and nothing else.
 */
export * from "./load-context";
export * from "./reviewer";
export * from "./aggregate";
export * from "./verify";
export * from "./triage";
export * from "./decide";
export * from "./report";
export { fileDiff, rank } from "./shared";
