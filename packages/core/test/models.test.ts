import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeClient, OpenRouterClient, RoutingModelClient, type ClaudeRunner, type ModelClient } from "../src";

/** A fake `claude` that records its arguments and replies with a canned JSON result. */
function fakeClaude(reply: Record<string, unknown>) {
  const calls: { args: string[]; input: string }[] = [];
  const run: ClaudeRunner = async (args, input) => {
    calls.push({ args, input });
    return JSON.stringify(reply);
  };
  return { calls, run };
}

const req = { tag: "review.security", system: "Be strict.", user: "the diff", json: true };

test("ClaudeCodeClient runs a tool-less session, passes the model and returns text and cost", async () => {
  const claude = fakeClaude({ result: '{"findings":[]}', total_cost_usd: 0.002, modelUsage: { "claude-opus-5-5": {} } });
  const res = await new ClaudeCodeClient(claude.run).complete({ ...req, model: "claude-code/opus" });

  const { args, input } = claude.calls[0]!;
  assert.equal(input, "the diff");
  const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--model"), "opus");
  assert.match(flag("--system-prompt"), /^Be strict\.\n\nReply with a single JSON object/);
  assert.deepEqual(res, { text: '{"findings":[]}', model: "claude-code/claude-opus-5-5", costUsd: 0.002 });
});

test("claude-code/default leaves the model to Claude Code", async () => {
  const claude = fakeClaude({ result: "ok" });
  await new ClaudeCodeClient(claude.run).complete({ ...req, json: false, model: "claude-code/default" });
  assert.ok(!claude.calls[0]!.args.includes("--model"));
});

test("ClaudeCodeClient reports a failed session", async () => {
  const claude = fakeClaude({ is_error: true, result: "Not logged in" });
  await assert.rejects(new ClaudeCodeClient(claude.run).complete({ ...req, model: "claude-code/sonnet" }), /Not logged in/);
});

test("RoutingModelClient sends claude-code/ IDs to Claude Code and everything else to OpenRouter", async () => {
  const named = (name: string): ModelClient => ({ complete: async (r) => ({ text: name, model: r.model }) });
  const router = new RoutingModelClient({ openrouter: named("or"), claudeCode: named("cc") });
  assert.equal((await router.complete({ ...req, model: "claude-code/sonnet" })).text, "cc");
  assert.equal((await router.complete({ ...req, model: "openai/gpt-5.5" })).text, "or");
  assert.throws(() => new RoutingModelClient({}).complete({ ...req, model: "openai/gpt-5.5" }), /No OpenRouter client/);
});

// ── OpenRouter retries ──────────────────────────────────────────────────────

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], model: "m", usage: { cost: 0.01 } }), { status: 200 });
const inFlight = (retryAfter?: string) =>
  new Response(
    JSON.stringify({ error: { code: 402, message: "in flight", metadata: { reason: "in_flight_budget_exhausted", headers: { "Retry-After": "120" } } } }),
    { status: 402, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
  );

/** An OpenRouter client whose fetch replays `replies` in order and whose sleep only records the wait. */
function fakeOpenRouter(replies: (() => Response)[]) {
  const waits: number[] = [];
  const notes: string[] = [];
  let calls = 0;
  const client = new OpenRouterClient("key", undefined, undefined, {
    fetch: async () => replies[calls++]!(),
    sleep: async (ms) => void waits.push(ms),
    onRetry: (note) => notes.push(note),
  });
  return { client, waits, notes, calls: () => calls };
}

test("OpenRouter: a 402 for in-flight budget waits as long as it's told, then retries", async () => {
  const f = fakeOpenRouter([() => inFlight("30"), ok]);
  const res = await f.client.complete({ ...req, model: "openai/gpt-5.5" });
  assert.equal(res.text, "hi");
  assert.deepEqual(f.waits, [30_000]);
  assert.equal(f.calls(), 2);
  assert.match(f.notes[0]!, /402 for review\.security, retrying in 30s/);
});

test("OpenRouter: Retry-After inside the error body counts when the header is missing", async () => {
  const f = fakeOpenRouter([() => inFlight(), ok]);
  await f.client.complete({ ...req, model: "openai/gpt-5.5" });
  assert.deepEqual(f.waits, [120_000]);
});

test("OpenRouter: 429 and 5xx retry with backoff, and give up after three retries", async () => {
  const busy = () => new Response("busy", { status: 503 });
  const f = fakeOpenRouter([busy, () => new Response("slow down", { status: 429 }), busy, busy]);
  await assert.rejects(f.client.complete({ ...req, model: "openai/gpt-5.5" }), /OpenRouter 503 for review\.security/);
  assert.equal(f.calls(), 4);
  assert.deepEqual(f.waits, [5_000, 10_000, 20_000]);
});

test("OpenRouter: a 402 that means no credit left, and other 4xx errors, fail at once", async () => {
  const noCredit = () => new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 402 });
  const f = fakeOpenRouter([noCredit]);
  await assert.rejects(f.client.complete({ ...req, model: "openai/gpt-5.5" }), /OpenRouter 402 for review\.security: .*Insufficient credits/);
  assert.equal(f.calls(), 1);
  const g = fakeOpenRouter([() => new Response("bad request", { status: 400 })]);
  await assert.rejects(g.client.complete({ ...req, model: "openai/gpt-5.5" }), /OpenRouter 400/);
  assert.equal(g.calls(), 1);
});
