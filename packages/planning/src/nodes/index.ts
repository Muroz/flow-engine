/**
 * Planning nodes, one file each, plus the routing in routing.ts.
 * Scaffolded: every node works (and runs offline), but the prompts are first
 * drafts — expect to iterate on them in /prompts/planning.
 *
 * Note the pattern around every human gate: the *model call* happens in one
 * node and the *gate* in the next. When a graph resumes after interrupt(),
 * the interrupted node re-runs from the top — so anything before interrupt()
 * in the same node would be paid for twice.
 *
 *   intake             deterministic  read the brief
 *   assessBrief        judge          is the brief complete enough?
 *   askQuestions       generative     discovery questions for the gaps
 *   clarify            human gate     you answer them
 *   writeRequirements  generative     testable requirements, MVP or later
 *   approveScope       human gate     approve, revise or discard the scope
 *   proposeOption      generative     one architecture per angle, in parallel
 *   adjustOption       generative     rework one option with your notes
 *   compareOptions     generative     a second model recommends one
 *   pickArchitecture   human gate     pick, revise, adjust or discard
 *   writeAdrs          generative     ADRs for the chosen architecture
 *   breakdown          generative     tasks with dependencies
 *   checkCoverage      judge          is every MVP requirement covered?
 *   approvePlan        human gate     approve or discard the plan
 *   emit               deterministic  write the PRD, ADRs and tasks.yaml
 */
export * from "./intake";
export * from "./assess-brief";
export * from "./ask-questions";
export * from "./clarify";
export * from "./write-requirements";
export * from "./approve-scope";
export * from "./propose-option";
export * from "./adjust-option";
export * from "./compare-options";
export * from "./pick-architecture";
export * from "./write-adrs";
export * from "./breakdown";
export * from "./check-coverage";
export * from "./approve-plan";
export * from "./emit";
export * from "./routing";
