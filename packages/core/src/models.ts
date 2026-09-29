/**
 * The generative model layer. Every node that *creates* something calls
 * `ModelClient.complete`; which model and which provider is config, not code.
 */

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
