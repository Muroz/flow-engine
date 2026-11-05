/**
 * The judge layer: small, typed decisions that sit on conditional edges.
 *
 *   "Is this finding real?"            → noul   (yes/no probability)
 *   "Which path next: pass/fix/escalate?" → choice (one of N + confidence)
 *   "How severe is this?"              → score  (position on an ordered scale)
 *
 * Judges never generate prose. That keeps them fast and cheap enough to run
 * on every edge, and it means code — not a model — decides what happens with
 * the answer.
 *
 * Three engines share one interface:
 *   JevJudge  – TypeSafe Jev (System One model), ~70–500 ms per call
 *   LlmJudge  – any OpenRouter model asked for structured JSON (fallback)
 *   MockJudge – deterministic, for offline runs and tests
 */
import { parseJsonReply, type ModelClient } from "./models";

// ── Question & answer types ─────────────────────────────────────────────────

export type NoulQ = { type: "noul"; instructions: string };
export type ChoiceQ<O extends string = string> = {
  type: "choice";
  instructions: string;
  options: Record<O, string>; // option key → description
};
export type ScoreQ<L extends string = string> = {
  type: "score";
  instructions: string;
  levels: readonly L[]; // ordered, lowest first
};
export type JudgeQuestion = NoulQ | ChoiceQ | ScoreQ;

export type NoulA = { p: number };
export type ChoiceA<O extends string = string> = {
  choice: O;
  confidence: number;
  /** Each option's probability, when the engine reports them. Jev does, at no extra cost; the LLM judge doesn't. */
  probabilities?: Partial<Record<O, number>>;
};
export type ScoreA<L extends string = string> = { level: L; index: number; confidence: number };

export type AnswerFor<Q> = Q extends ChoiceQ<infer O>
  ? ChoiceA<O>
  : Q extends ScoreQ<infer L>
    ? ScoreA<L>
    : Q extends NoulQ
      ? NoulA
      : never;

export type Answers<Q extends Record<string, JudgeQuestion>> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface Judge {
  readonly name: string;
  /** Ask several questions about one piece of state in a single pass. */
  ask<Q extends Record<string, JudgeQuestion>>(state: unknown, questions: Q): Promise<Answers<Q>>;
}

// Small constructors so call sites read like the decision they make.
export const noul = (instructions: string): NoulQ => ({ type: "noul", instructions });
export const choice = <O extends string>(instructions: string, options: Record<O, string>): ChoiceQ<O> => ({
  type: "choice",
  instructions,
  options,
});
export const score = <L extends string>(instructions: string, levels: readonly L[]): ScoreQ<L> => ({
  type: "score",
  instructions,
  levels,
});

// ── Jev ─────────────────────────────────────────────────────────────────────

/**
 * TypeSafe Jev over plain fetch.
 * API shape per TypeSafe's launch docs (Sept 2026) — verify against
 * https://console.typesafe.ai if calls fail. The official SDK is
 * `@typesafe-ai/sdk` if you'd rather use it; only this class would change.
 */
export class JevJudge implements Judge {
  readonly name = "jev";

  constructor(
    private readonly apiKey: string,
    private readonly model = "jev-latest",
    private readonly url = "https://api.typesafe.ai/v1/systemone",
  ) {}

  async ask<Q extends Record<string, JudgeQuestion>>(state: unknown, questions: Q): Promise<Answers<Q>> {
    const wire: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.type === "noul") wire[key] = { type: "noul", instructions: q.instructions };
      if (q.type === "choice") wire[key] = { type: "choice", instructions: q.instructions, criteria: q.options };
      if (q.type === "score") wire[key] = { type: "score", instructions: q.instructions, criteria: q.levels };
    }

    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, state, questions: wire }),
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
    const body: any = await res.json();

    const out: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      const a = body.answers?.[key] ?? {};
      if (q.type === "noul") {
        out[key] = { p: Number(a.noul ?? 0) };
      } else if (q.type === "choice") {
        out[key] = { choice: a.choice, confidence: Number(a.confidence ?? a.probabilities?.[a.choice] ?? 0), probabilities: jevProbabilities(a.probabilities) };
      } else {
        const index = jevScoreIndex(a, q.levels);
        out[key] = { level: q.levels[index], index, confidence: Number(a.confidence ?? 0) };
      }
    }
    return out as Answers<Q>;
  }
}

/** Jev's per-option probabilities, keeping only numbers; undefined when it sent none. */
export function jevProbabilities(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out = Object.fromEntries(Object.entries(raw).filter(([, p]) => typeof p === "number" && Number.isFinite(p))) as Record<string, number>;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Jev's `score` is a weighted position on the scale, such as 2.2, not an
 * index. Take the most probable level; without probabilities, round the score.
 */
export function jevScoreIndex(a: { score?: unknown; probabilities?: Record<string, number> }, levels: readonly string[]): number {
  let index: number;
  const probs = Object.entries(a.probabilities ?? {});
  if (probs.length) index = Number(probs.reduce((best, p) => (p[1] > best[1] ? p : best))[0]);
  else if (typeof a.score === "number") index = Math.round(a.score);
  else index = levels.indexOf(String(a.score));
  return Number.isFinite(index) ? Math.min(levels.length - 1, Math.max(0, index)) : 0;
}

// ── LLM fallback ────────────────────────────────────────────────────────────

/** Same contract, implemented with a structured-output call to a normal LLM. */
export class LlmJudge implements Judge {
  readonly name = "llm";

  constructor(
    private readonly model: ModelClient,
    private readonly modelId: string,
  ) {}

  async ask<Q extends Record<string, JudgeQuestion>>(state: unknown, questions: Q): Promise<Answers<Q>> {
    const spec = Object.entries(questions).map(([key, q]) => {
      if (q.type === "noul") return `- "${key}" (yes/no): ${q.instructions}. Answer {"p": <probability of yes 0..1>}`;
      if (q.type === "choice")
        return `- "${key}" (choice): ${q.instructions}. Options: ${JSON.stringify(q.options)}. Answer {"choice": <key>, "confidence": 0..1}`;
      return `- "${key}" (score): ${q.instructions}. Levels low→high: ${JSON.stringify(q.levels)}. Answer {"level": <level>, "confidence": 0..1}`;
    });

    const { text } = await this.model.complete({
      tag: "judge.llm",
      model: this.modelId,
      json: true,
      temperature: 0,
      system: "You are a strict evaluator. Reply with a single JSON object keyed by question id. No prose.",
      user: `STATE:\n${typeof state === "string" ? state : JSON.stringify(state, null, 2)}\n\nQUESTIONS:\n${spec.join("\n")}`,
    });

    const raw = parseJsonReply<Record<string, any>>(text, {});
    const out: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      const a = raw[key] ?? {};
      if (q.type === "noul") out[key] = { p: clamp01(a.p) };
      else if (q.type === "choice") {
        const keys = Object.keys(q.options);
        out[key] = { choice: keys.includes(a.choice) ? a.choice : keys[0], confidence: clamp01(a.confidence) };
      } else {
        const index = Math.max(0, q.levels.indexOf(a.level));
        out[key] = { level: q.levels[index], index, confidence: clamp01(a.confidence) };
      }
    }
    return out as Answers<Q>;
  }
}

// ── Mock ────────────────────────────────────────────────────────────────────

/** Per-question override: return an answer, or undefined for the default. */
export type MockJudgeRule = (key: string, q: JudgeQuestion, state: unknown) => unknown | undefined;

export class MockJudge implements Judge {
  readonly name = "mock";
  private rules: MockJudgeRule[] = [];

  rule(r: MockJudgeRule): this {
    this.rules.push(r);
    return this;
  }

  async ask<Q extends Record<string, JudgeQuestion>>(state: unknown, questions: Q): Promise<Answers<Q>> {
    const out: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      let answer: unknown;
      for (const r of this.rules) {
        answer = r(key, q, state);
        if (answer !== undefined) break;
      }
      if (answer === undefined) {
        // Defaults: optimistic but not certain.
        if (q.type === "noul") answer = { p: 0.8 };
        else if (q.type === "choice") answer = { choice: Object.keys(q.options)[0], confidence: 0.7 };
        else answer = { level: q.levels[0], index: 0, confidence: 0.7 };
      }
      out[key] = answer;
    }
    return out as Answers<Q>;
  }
}

function clamp01(n: unknown): number {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
