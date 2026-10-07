/**
 * Drives a checkpointed graph to the end, pausing at each human gate.
 *
 *   stream → graph hits interrupt(GateRequest) → we ask you → Command({ resume })
 *          → graph resumes at that node → … → END
 *
 * Every gate also offers two choices of the driver's own:
 *   back   re-opens the previous gate by forking the run from that gate's
 *          checkpoint, so everything after it runs again
 *   pause  stops here; `flows resume <run id>` picks the gate up again
 *
 * The CLI is one front end. Any other (a web page, a chat bot) needs only the
 * same loop over the same checkpoints.
 */
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline";
import type { GateDecision, GateRequest, LogEntry } from "@flows/core";
import { Command } from "@langchain/langgraph";

type RunConfig = { configurable?: Record<string, unknown> };

type Snapshot = {
  values: unknown;
  next: readonly string[];
  config: RunConfig;
  tasks: readonly { interrupts?: readonly { value?: unknown }[] }[];
};

/** The parts of a compiled LangGraph graph the driver uses. Loose types, so any graph's state fits. */
type Checkpointed = {
  stream(input: any, config: any): Promise<AsyncIterable<any>>;
  getState(config: any): Promise<Snapshot>;
  updateState(config: any, values: any): Promise<any>;
};

/** Reads one answer at a time. Tests pass a scripted one. */
export type Prompter = { ask(question: string): Promise<string>; close(): void };

export type DriveOptions = {
  yes: boolean;
  /** Checkpoints of earlier gates, oldest first, saved when a run pauses. */
  gateStack?: RunConfig[];
  prompter?: Prompter;
  /** Where progress and gates are printed. */
  print?: (line: string) => void;
};

export type DriveResult<S> =
  | { status: "done"; values: S }
  | { status: "paused"; gate: GateRequest; gateStack: RunConfig[] };

/** Navigation choices the driver adds to every gate. */
export const BACK = "back";
export const PAUSE = "pause";
/** Choices that throw work away ask for confirmation first. */
const CONFIRM = new Set(["discard", "reject", "abort"]);
/** Choices that mean nothing without notes. */
const NEEDS_NOTES = new Set(["revise", "adjust"]);

/**
 * Runs `input` on thread `threadId`, or, when `input` is undefined, picks up
 * the gate the thread is already waiting at.
 */
export async function drive<S>(graph: Checkpointed, input: unknown, threadId: string, opts: DriveOptions): Promise<DriveResult<S>> {
  const thread: RunConfig = { configurable: { thread_id: threadId } };
  const print = opts.print ?? ((line: string) => console.log(line));
  const prompter = opts.prompter ?? (opts.yes ? undefined : terminalPrompter());
  const gateStack = [...(opts.gateStack ?? [])];

  let next: unknown = input;
  let from: RunConfig = thread;
  if (next === undefined) {
    // Resuming. A run that stopped between gates, for example after a crash, carries on from its last checkpoint.
    const snapshot = await graph.getState(thread);
    if (!snapshot.tasks.some((t) => t.interrupts?.length) && snapshot.next.length) next = null;
  }
  try {
    for (;;) {
      if (next !== undefined) await runWithProgress(graph, next, from, print);
      const snapshot = await graph.getState(thread);
      const request = snapshot.tasks.flatMap((t) => t.interrupts ?? [])[0]?.value as GateRequest | undefined;
      if (!request) return { status: "done", values: snapshot.values as S };

      const choices = [...request.options, ...(gateStack.length ? [BACK] : []), PAUSE];
      showGate(request, choices, print);
      const decision = opts.yes ? autoPick(request, print) : await choose(choices, prompter!, print);

      if (decision.decision === PAUSE) return { status: "paused", gate: request, gateStack };
      if (decision.decision === BACK) {
        // A fork from the earlier gate's checkpoint, without the answer you gave there.
        from = await graph.updateState(gateStack.pop()!, {});
        next = null;
        continue;
      }
      gateStack.push(snapshot.config);
      next = new Command({ resume: decision });
      from = thread;
    }
  } finally {
    prompter?.close();
  }
}

async function runWithProgress(graph: Checkpointed, input: unknown, config: RunConfig, print: (line: string) => void) {
  const ticker = workingTicker();
  let last = Date.now();
  try {
    for await (const update of await graph.stream(input, { ...config, streamMode: "updates" })) {
      for (const [node, value] of Object.entries(update)) {
        if (node === "__interrupt__") continue;
        const log = ((value as { log?: LogEntry[] } | null)?.log ?? []).at(-1);
        ticker.clear();
        print(progressLine(node, log, (Date.now() - last) / 1000));
        last = Date.now();
      }
    }
  } finally {
    ticker.stop();
  }
}

export function progressLine(node: string, log: LogEntry | undefined, seconds: number): string {
  const cost = log?.costUsd ? `  $${log.costUsd.toFixed(4)}` : "";
  const note = log?.note ? `  ${log.note}` : "";
  return `  ✓ ${(log?.node ?? node).padEnd(28)} ${seconds.toFixed(1).padStart(5)}s${cost}${note}`;
}

/** On a terminal, a line that counts seconds while a node runs, so a slow model call never looks frozen. */
function workingTicker() {
  if (!stdout.isTTY) return { clear() {}, stop() {} };
  let started = Date.now();
  const draw = () => stdout.write(`\r  … working (${Math.round((Date.now() - started) / 1000)}s)`);
  const timer = setInterval(draw, 1000);
  return {
    clear() {
      stdout.write("\r\x1b[K");
      started = Date.now();
    },
    stop() {
      clearInterval(timer);
      stdout.write("\r\x1b[K");
    },
  };
}

function showGate(req: GateRequest, choices: string[], print: (line: string) => void) {
  print(`\n┏━ 🙋 ${req.title}  [${req.gate}]`);
  for (const line of req.summary.split("\n")) print(`┃ ${line}`);
  if (req.detailPath) print(`┃ full text: ${req.detailPath}`);
  print(`┗━ ${choices.map((c, i) => `${i + 1}) ${c}`).join("  ")}`);
}

function autoPick(req: GateRequest, print: (line: string) => void): GateDecision {
  print(`   → auto: ${req.options[0]}`);
  return { decision: req.options[0]! };
}

/** Asks until the answer names a choice or its number. An empty line never counts as an answer. */
export async function choose(choices: string[], prompter: Prompter, print: (line: string) => void): Promise<GateDecision> {
  for (;;) {
    const answer = (await prompter.ask("   choice: ")).trim();
    const byNumber = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
    const decision = byNumber ?? choices.find((c) => c.toLowerCase() === answer.toLowerCase());
    if (!decision) {
      print(`   type one of: ${choices.join(", ")}, or its number`);
      continue;
    }
    if (decision === BACK || decision === PAUSE) return { decision };

    if (CONFIRM.has(decision)) {
      const sure = (await prompter.ask(`   ${decision} throws this work away. Are you sure? [y/N] `)).trim().toLowerCase();
      if (sure !== "y" && sure !== "yes") continue;
    }

    let notes = (await prompter.ask(NEEDS_NOTES.has(decision) ? "   notes: " : "   notes (optional): ")).trim();
    while (NEEDS_NOTES.has(decision) && !notes) notes = (await prompter.ask(`   ${decision} needs notes. notes: `)).trim();
    return { decision, notes: notes || undefined };
  }
}

/**
 * One readline for the whole run. Lines are queued as they arrive, so piped
 * answers aren't lost between questions.
 */
function terminalPrompter(): Prompter {
  let rl: Interface | undefined;
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let closed = false;
  const open = () => {
    if (rl) return;
    rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
    rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : queued.push(line)));
    rl.on("close", () => {
      closed = true;
      while (waiting.length) waiting.shift()!("");
    });
  };
  return {
    ask(question) {
      open();
      stdout.write(question);
      if (queued.length) return Promise.resolve(queued.shift()!);
      if (closed) throw new Error("No more input: the gate needs an answer.");
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() {
      rl?.close();
    },
  };
}
