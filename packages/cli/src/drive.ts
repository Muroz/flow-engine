/**
 * Drives a checkpointed graph to completion, pausing at each human gate.
 *
 *   invoke → graph hits interrupt(GateRequest) → we ask you → Command({ resume })
 *          → graph resumes at that node → … → END
 *
 * The CLI is just one front end. Because the run is checkpointed by thread id,
 * the same loop could live in a Slack bot or a web page, and the "ask" step
 * could happen hours later. (Swap MemorySaver for a persistent checkpointer,
 * e.g. @langchain/langgraph-checkpoint-sqlite, to survive process restarts.)
 */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { GateDecision, GateRequest } from "@flows/core";
import { Command } from "@langchain/langgraph";

type Checkpointed = {
  invoke(input: unknown, config: { configurable: { thread_id: string } }): Promise<unknown>;
  getState(config: { configurable: { thread_id: string } }): Promise<{
    values: unknown;
    tasks: readonly { interrupts?: readonly { value?: unknown }[] }[];
  }>;
};

export async function drive<S>(graph: Checkpointed, input: unknown, threadId: string, opts: { yes: boolean }): Promise<S> {
  const config = { configurable: { thread_id: threadId } };
  let next: unknown = input;

  for (;;) {
    await graph.invoke(next, config);
    const snapshot = await graph.getState(config);
    const pending = snapshot.tasks.flatMap((t) => t.interrupts ?? []);
    if (pending.length === 0) return snapshot.values as S;

    const request = pending[0]!.value as GateRequest;
    const decision = await ask(request, opts.yes);
    next = new Command({ resume: decision });
  }
}

async function ask(req: GateRequest, autoYes: boolean): Promise<GateDecision> {
  console.log(`\n┏━ 🙋 ${req.title}  [${req.gate}]`);
  for (const line of req.summary.split("\n")) console.log(`┃ ${line}`);
  if (req.detailPath) console.log(`┃ details: ${req.detailPath}`);
  console.log(`┗━ options: ${req.options.join(" / ")}`);

  if (autoYes) {
    console.log(`   → auto: ${req.options[0]}`);
    return { decision: req.options[0]! };
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`   decision [${req.options[0]}]: `)).trim() || req.options[0]!;
      if (req.options.includes(answer)) {
        const notes = (await rl.question("   notes (optional): ")).trim();
        return { decision: answer, notes: notes || undefined };
      }
      console.log(`   pick one of: ${req.options.join(", ")}`);
    }
  } finally {
    rl.close();
  }
}
