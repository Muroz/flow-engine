/**
 * Offline behaviour for the review flow: cheap heuristics that stand in for
 * the specialist models and the judge, so `--offline` exercises every node
 * and edge with no keys and no network. Not a real reviewer — a test double.
 */
import { MockJudge, MockModelClient, SEVERITIES, type FlowDeps, type Severity } from "@flows/core";

type Hit = { title: string; file?: string; line?: number; severity: Severity; rationale: string; suggestion?: string };

/** Added lines with their file and new-file line number. */
function addedLines(diff: string): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    const f = raw.match(/^\+\+\+ b\/(.+)$/);
    if (f) { file = f[1]!; continue; }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { line = Number(h[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) { out.push({ file, line, text: raw.slice(1) }); line++; }
    else if (!raw.startsWith("-")) line++;
  }
  return out;
}

const HEURISTICS: Record<string, (diff: string, user: string) => Hit[]> = {
  security: (diff) =>
    addedLines(diff).flatMap(({ file, line, text }) => {
      const hits: Hit[] = [];
      if (/(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{6,}["']/i.test(text))
        hits.push({ title: "Hard-coded secret", file, line, severity: "blocker", rationale: "A credential is committed in source.", suggestion: "Read it from the environment / secret store." });
      if (/`[^`]*(SELECT|INSERT|UPDATE|DELETE)[^`]*\$\{/i.test(text))
        hits.push({ title: "SQL built with string interpolation", file, line, severity: "blocker", rationale: "User input reaches the query unescaped (SQL injection).", suggestion: "Use a parameterised query." });
      if (/\beval\(|new Function\(/.test(text))
        hits.push({ title: "Dynamic code execution", file, line, severity: "major", rationale: "eval/new Function on runtime data." });
      return hits;
    }),

  correctness: (diff) =>
    addedLines(diff).flatMap(({ file, line, text }) => {
      const hits: Hit[] = [];
      if (/catch\s*(\(\w*\))?\s*\{\s*\}/.test(text))
        hits.push({ title: "Error swallowed silently", file, line, severity: "minor", rationale: "Empty catch hides failures from callers and logs." });
      if (/[^=!]==[^=]/.test(text))
        hits.push({ title: "Loose equality", file, line, severity: "nit", rationale: "`==` coerces types." });
      return hits;
    }),

  tests: (diff) => {
    const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!);
    const touchesSrc = files.some((f) => f.startsWith("src/") && !/\.(test|spec)\./.test(f));
    const touchesTests = files.some((f) => /\.(test|spec)\.|__tests__|^test\//.test(f));
    return touchesSrc && !touchesTests
      ? [{ title: "No tests for changed behaviour", severity: "major", rationale: "Source changed but no test files were added or updated.", suggestion: "Add tests covering the acceptance criteria." }]
      : [];
  },

  architecture: (diff, user) =>
    /repository/i.test(user)
      ? addedLines(diff)
          .filter(({ file, text }) => !file.startsWith("src/db/") && /from ["']pg["']|new Pool\(/.test(text))
          .map(({ file, line }) => ({ title: "Bypasses the repository layer (ADR-0001)", file, line, severity: "major" as const, rationale: "Direct database access outside src/db/ contradicts ADR-0001." }))
      : [],

  spec: (diff, user) => {
    const criteria = user.match(/ACCEPTANCE CRITERIA:\n([\s\S]*?)\n\n/)?.[1]?.split("\n").map((l) => l.replace(/^- /, "")) ?? [];
    const lower = diff.toLowerCase();
    return criteria
      .filter((c) => {
        // "Met" if at least half of the criterion's meaningful words show up in the diff.
        const words = c.toLowerCase().split(/\W+/).filter((w) => w.length > 5);
        return words.length > 0 && words.filter((w) => lower.includes(w)).length < words.length / 2;
      })
      .map((c) => ({ title: `Acceptance criterion not evidently met: "${c}"`, severity: "minor" as const, rationale: "Nothing in the diff appears to address this criterion." }));
  },
};

// How sure the fake judge is, by the reviewer's own severity.
const MOCK_CONFIDENCE: Record<Severity, number> = { nit: 0.45, minor: 0.7, major: 0.85, blocker: 0.92 };

export function registerReviewMocks(deps: FlowDeps): void {
  if (deps.model instanceof MockModelClient) {
    deps.model.register((req) => {
      const id = req.tag.match(/^review\.(\w+)$/)?.[1];
      const h = id ? HEURISTICS[id] : undefined;
      if (!h) return undefined;
      const start = req.user.indexOf("DIFF:");
      const end = req.user.indexOf("Reply with a single JSON object");
      const diff = req.user.slice(start, end > start ? end : undefined);
      return JSON.stringify({ findings: h(diff, req.user) });
    });
  }
  if (deps.judge instanceof MockJudge) {
    deps.judge.rule((key, _q, state: any) => {
      const sev: Severity | undefined = state?.finding?.severity;
      if (!sev) return undefined;
      if (key === "real") return { p: MOCK_CONFIDENCE[sev] };
      if (key === "severity") return { level: sev, index: SEVERITIES.indexOf(sev), confidence: 0.8 };
      return undefined;
    });
  }
}
