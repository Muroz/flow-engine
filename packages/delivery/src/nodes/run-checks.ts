import { spawn } from "node:child_process";
import { logEntry, type FlowDeps } from "@flows/core";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { CheckResult, DeliveryState, DeliveryUpdate } from "../state";
import { say } from "./shared";

/**
 * Deterministic. Runs `delivery.checks` from .flows.yaml in the worktree, in
 * order, and stops at the first failure. A failure's last 2,000 characters
 * become a note for the agent. Offline, or with no checks set, it passes
 * without running anything.
 *
 * Reads `workdir`. Writes `checks`, and `fixNotes` on a failure.
 */
export const runChecks =
  (deps: FlowDeps) =>
  async (s: DeliveryState, config?: LangGraphRunnableConfig): Promise<DeliveryUpdate> => {
    const cmds = deps.config.delivery.checks;
    if (deps.offline || cmds.length === 0) {
      return { checks: { passed: true, output: "skipped", results: [] }, log: [logEntry("delivery.checks", { note: "skipped" })] };
    }
    const results: CheckResult[] = [];
    let failure: string | undefined;
    for (const command of cmds) {
      if (failure) {
        results.push({ command, status: "not run", seconds: 0 });
        continue;
      }
      say(config, `      running ${command}`);
      const started = Date.now();
      const { code, output } = await runCommand(command, s.workdir ?? deps.config.repoDir);
      const seconds = (Date.now() - started) / 1000;
      results.push({ command, status: code === 0 ? "passed" : "failed", seconds });
      if (code !== 0) failure = `${command} failed:\n${output.slice(-2000)}`;
    }
    const passed = !failure;
    return {
      checks: { passed, output: failure ?? "ok", results },
      ...(failure ? { fixNotes: [failure] } : {}),
      log: [
        logEntry("delivery.checks", {
          note: passed ? `${cmds.length} passed` : `failed: ${results.find((r) => r.status === "failed")!.command}`,
          details: results.map(describeCheck),
        }),
      ],
    };
  };

/** One check as a line, such as "✓ pnpm test (4.2s)". */
export const describeCheck = (r: CheckResult) =>
  `${{ passed: "✓", failed: "✗", "not run": "·" }[r.status]} ${r.command}${r.status === "not run" ? " (not run)" : ` (${r.seconds.toFixed(1)}s)`}`;

/** Runs one shell command, with a ten-minute limit, and returns its exit code and combined output. */
function runCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (e) => resolve({ code: 1, output: String(e) }));
  });
}
