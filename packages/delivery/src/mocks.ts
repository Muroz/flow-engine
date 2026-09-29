import { MockJudge, MockModelClient, type FlowDeps } from "@flows/core";

/** Offline stand-ins for the delivery flow's model and judge calls. */
export function registerDeliveryMocks(deps: FlowDeps): void {
  if (deps.model instanceof MockModelClient) {
    deps.model.register((req) =>
      req.tag === "delivery.plan"
        ? JSON.stringify({
            summary: "Add a search handler backed by a new repository function, with validation and pagination.",
            steps: [
              "Add searchOrders(filters, page) to src/db/repository.ts using a parameterised query",
              "Add src/routes/search.ts that validates status/date inputs (400 on invalid dates)",
              "Cap page size at 50",
              "Add tests for filters, pagination and invalid dates",
            ],
          })
        : undefined,
    );
  }
  if (deps.judge instanceof MockJudge) {
    // Fake judge: agrees with the risk the planning flow assigned.
    deps.judge.rule((key, _q, state: any) => {
      if (key !== "risk" || !state?.task) return undefined;
      const levels = ["low", "medium", "high"];
      const index = Math.max(0, levels.indexOf(state.task.risk));
      return { level: levels[index], index, confidence: 0.75 };
    });
  }
}
