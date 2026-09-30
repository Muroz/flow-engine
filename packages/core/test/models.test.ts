import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeClient, RoutingModelClient, type ClaudeRunner, type ModelClient } from "../src";

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
