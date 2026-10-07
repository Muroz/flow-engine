import { MockJudge, MockModelClient, type FlowDeps } from "@flows/core";

const REQUIREMENTS = [
  { id: "R-1", title: "Start a return within the window", text: "Customers can start a return for an eligible order within the return window.", area: "Returns", priority: "mvp" },
  { id: "R-2", title: "Choose items and reasons", text: "Customers choose items and a reason for each.", area: "Returns", priority: "mvp" },
  { id: "R-3", title: "Get a printable label", text: "Customers receive a printable shipping label.", area: "Labels", priority: "mvp" },
  { id: "R-4", title: "Staff approve or reject returns", text: "Support staff can review pending returns and approve or reject them.", area: "Support", priority: "mvp" },
  { id: "R-5", title: "Email updates on return status", text: "Customers get an email when their return changes status.", area: "Support", priority: "later" },
];

const option = (pitch: string, firstDelivery: string, monthlyCost: string, opsBurden: string, lockIn: string, summary: string, tradeoffs: string[]) => ({
  pitch,
  facts: { firstDelivery, monthlyCost, opsBurden, lockIn },
  summary,
  tradeoffs,
});

/** Offline stand-ins for the planning flow. Shaped so the loops actually run once. */
export function registerPlanningMocks(deps: FlowDeps): void {
  if (deps.model instanceof MockModelClient) {
    deps.model.register((req) => {
      switch (req.tag) {
        case "planning.questions":
          return JSON.stringify({
            questions: [
              "Who pays for return shipping, and does it vary by reason?",
              "Which carrier(s) issue labels today?",
              "Is there a return window (e.g. 30 days)?",
              "What does success look like — fewer support emails, faster refunds?",
            ],
          });
        case "planning.requirements":
          return JSON.stringify({ requirements: REQUIREMENTS });
        case "planning.reviseRequirements":
          // Pretends the notes asked for one new requirement.
          return JSON.stringify({
            requirements: [
              ...REQUIREMENTS,
              { id: "R-6", title: "Customers see return status", text: "Customers can see whether their return is pending, approved or rejected.", area: "Returns", priority: "mvp" },
            ],
          });
        case "planning.option": {
          const angle = req.user.match(/ANGLE: (.*)/)?.[1] ?? "";
          return JSON.stringify(
            angle.startsWith("simplest")
              ? option("Add a returns module to the existing API.", "2 weeks", "about $0 extra", "low", "low", "Extend the existing API with a returns module and Postgres tables; labels via the carrier's REST API.", ["Fastest to ship", "Carrier coupling in our code"])
              : angle.startsWith("built")
                ? option("Run returns as its own service.", "6 weeks", "about $150", "high", "low", "Separate returns service with an event bus between orders, returns and labels.", ["Scales independently", "Much more infrastructure for a small client"])
                : option("Use a hosted returns platform.", "1 week", "about $300", "low", "high", "Use a hosted returns platform and integrate via webhooks.", ["Least code", "Monthly fee and less control over UX"]),
          );
        }
        case "planning.adjustOption":
          return JSON.stringify(option("Add a returns module, with labels from a second carrier.", "3 weeks", "about $0 extra", "low", "low", "Same as before, with a second carrier behind the adapter.", ["Carrier choice", "One more integration to test"]));
        case "planning.compare":
          return JSON.stringify({ recommended: "A", why: "Smallest change to a stack the client already runs; the scale option is premature." });
        case "planning.adrs":
          return JSON.stringify({
            adrs: [
              { title: "Returns live in the existing API as a module", context: "Small client, one team, existing Node/Postgres API.", decision: "Add a returns module to the existing API with its own tables; no new service.", consequences: "Simple deploys; revisit if returns volume grows 10x." },
              { title: "Carrier access goes through a single adapter", context: "Labels come from an external carrier API.", decision: "All carrier calls go through src/carriers/adapter.ts so the carrier can be swapped.", consequences: "One extra layer; tests stub the adapter." },
            ],
          });
        case "planning.breakdown": {
          const t = (id: string, title: string, reqs: string[], deps: string[], ac: string[], risk = "low") => ({
            id, title, requirementIds: reqs, adrRefs: ["ADR-0001"], dependsOn: deps, acceptanceCriteria: ac, risk, estimate: "M",
          });
          const tasks = [
            t("T-001", "Returns schema and eligibility rules", ["R-1"], [], ["Orders outside the window are ineligible"], "medium"),
            t("T-002", "Start-return API: items and reasons", ["R-1", "R-2"], ["T-001"], ["Each item needs a reason", "Rejects ineligible orders"]),
            t("T-003", "Carrier adapter and label generation", ["R-3"], ["T-002"], ["Returns a printable PDF label"], "medium"),
          ];
          // First round "forgets" the support workflow so the coverage loop has something to catch.
          if (req.user.includes("GAPS"))
            tasks.push(t("T-004", "Support review queue: approve/reject", ["R-4"], ["T-002"], ["Staff see pending returns", "Approve/reject is audited"]));
          return JSON.stringify({ tasks });
        }
      }
      return undefined;
    });
  }

  if (deps.judge instanceof MockJudge) {
    deps.judge.rule((key, _q, state: any) => {
      // Brief completeness: incomplete until discovery answers have been added.
      if (key === "complete" && typeof state?.brief === "string")
        return { p: state.brief.includes("Answers to discovery questions") ? 0.85 : 0.4 };
      // Coverage: covered if some task claims the requirement.
      const m = key.match(/^R_(\d+)$/);
      if (m && Array.isArray(state?.tasks)) {
        const covered = state.tasks.some((t: any) => t.requirementIds?.includes(`R-${m[1]}`));
        return { p: covered ? 0.9 : 0.1 };
      }
      return undefined;
    });
  }
}
