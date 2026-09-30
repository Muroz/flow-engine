/**
 * The generative model layer. Every node that *creates* something calls
 * `ModelClient.complete`; which model and which provider is config, not code.
 *
 * A model ID picks its backend. `claude-code/<model>` runs the local Claude
 * Code CLI; anything else is an OpenRouter slug. Roles can mix the two.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export type CompletionRequest = {
  model: string;
  system: string;
  user: string;
  /** Ask for a JSON object back (OpenRouter `response_format`). */
  json?: boolean;
  temperature?: number;
  /**
   * Identifies the calling node ("review.security", "planning.requirements").
   * Used for tracing, and by the mock client to pick an offline response.
   */
  tag: string;
};

export type CompletionResult = {
  text: string;
  model: string;
  costUsd?: number;
};

export interface ModelClient {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

// ── OpenRouter ──────────────────────────────────────────────────────────────

export class OpenRouterClient implements ModelClient {
  constructor(
    private readonly apiKey: string,
    /** Forwarded as OpenRouter's `provider` routing object (data policy, allow-lists). */
    private readonly provider?: Record<string, unknown>,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "flow-engine",
      },
      body: JSON.stringify({
        model: req.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: req.temperature ?? 0.2,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
        ...(this.provider ? { provider: this.provider } : {}),
        usage: { include: true }, // returns cost so every node can log it
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status} for ${req.tag}: ${await res.text()}`);
    }

    const body: any = await res.json();
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      model: body.model ?? req.model,
      costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : undefined,
    };
  }
}

// ── Claude Code ─────────────────────────────────────────────────────────────

/** Model IDs with this prefix run on the local Claude Code CLI instead of OpenRouter. */
export const CLAUDE_CODE_PREFIX = "claude-code/";

export function isClaudeCodeModel(model: string): boolean {
  return model.startsWith(CLAUDE_CODE_PREFIX);
}

/** Runs `claude` with these arguments, writes `input` to its stdin and resolves with stdout. */
export type ClaudeRunner = (args: string[], input: string) => Promise<string>;

/**
 * The local Claude Code CLI as a plain completion model. It uses whatever
 * sign-in `claude` already has, so it needs no key of its own.
 *
 * Each call is a fresh headless session with every tool turned off, no
 * settings files, no MCP servers and no saved session: the model sees the
 * system prompt and the user message, nothing else. The part after the
 * prefix goes to `--model` (`sonnet`, `opus` or a full model name);
 * `claude-code/default` leaves the choice to Claude Code. There is no
 * temperature setting, so `temperature` is ignored.
 */
export class ClaudeCodeClient implements ModelClient {
  constructor(private readonly run: ClaudeRunner = runClaudeCli) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const alias = req.model.slice(CLAUDE_CODE_PREFIX.length);
    const system = req.json ? `${req.system}\n\nReply with a single JSON object and nothing else.` : req.system;
    const args = [
      "-p",
      "--output-format", "json",
      "--tools", "",
      "--system-prompt", system,
      "--setting-sources", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      ...(alias && alias !== "default" ? ["--model", alias] : []),
    ];

    const out = await this.run(args, req.user);
    let body: any;
    try {
      body = JSON.parse(out);
    } catch {
      throw new Error(`Claude Code returned no JSON for ${req.tag}: ${out.slice(0, 500)}`);
    }
    if (body.is_error) throw new Error(`Claude Code failed for ${req.tag}: ${body.result ?? body.subtype ?? "unknown error"}`);

    const used = Object.keys(body.modelUsage ?? {})[0];
    return {
      text: String(body.result ?? ""),
      model: used ? `${CLAUDE_CODE_PREFIX}${used}` : req.model,
      costUsd: typeof body.total_cost_usd === "number" ? body.total_cost_usd : undefined,
    };
  }
}

/**
 * Spawns `claude` from the system temp folder, so it never picks up a
 * project's CLAUDE.md. Async, so fan-out nodes run their calls in parallel.
 */
export const runClaudeCli: ClaudeRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"], timeout: 10 * 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error("claude-code models need the Claude Code CLI on your PATH.") : e),
    );
    child.on("close", (code) => {
      // A failed session still prints its JSON result; let the caller report it.
      if (code === 0 || stdout.trim().startsWith("{")) resolve(stdout);
      else reject(new Error(`claude exited with ${code}: ${(stderr || stdout).slice(0, 500)}`));
    });
    child.stdin.end(input);
  });

// ── Routing ─────────────────────────────────────────────────────────────────

/** Sends each request to Claude Code or OpenRouter by its model ID. */
export class RoutingModelClient implements ModelClient {
  constructor(private readonly routes: { openrouter?: ModelClient; claudeCode?: ModelClient }) {}

  complete(req: CompletionRequest): Promise<CompletionResult> {
    const cc = isClaudeCodeModel(req.model);
    const client = cc ? this.routes.claudeCode : this.routes.openrouter;
    if (!client) throw new Error(`No ${cc ? "Claude Code" : "OpenRouter"} client for ${req.model} (${req.tag}).`);
    return client.complete(req);
  }
}

// ── Offline mock ────────────────────────────────────────────────────────────

/** Returns the canned text for a request, or undefined to fall through. */
export type MockResponder = (req: CompletionRequest) => string | undefined;

/**
 * Deterministic stand-in for offline runs and tests. Each flow registers
 * responders for its own tags, so the whole graph can run with no network.
 */
export class MockModelClient implements ModelClient {
  private responders: MockResponder[] = [];

  register(responder: MockResponder): this {
    this.responders.push(responder);
    return this;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    for (const r of this.responders) {
      const text = r(req);
      if (text !== undefined) return { text, model: `mock:${req.model}`, costUsd: 0 };
    }
    return {
      text: req.json ? "{}" : `[mock output for ${req.tag}]`,
      model: `mock:${req.model}`,
      costUsd: 0,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Pull the first JSON object out of a model reply (tolerates ```json fences and prose). */
export function parseJsonReply<T>(text: string, fallback: T): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return fallback;
  }
}
