Reply with a single JSON object and nothing else:

{"findings": [{"title": "short imperative summary", "file": "path/in/diff.ts", "line": 42, "severity": "nit|minor|major|blocker", "rationale": "why this is a problem, one or two sentences", "suggestion": "concrete fix (optional)"}]}

Severity guide: blocker = must not merge (security hole, data loss, broken build); major = real bug or clear requirement miss; minor = worth fixing, not blocking; nit = taste.
Only report problems introduced or touched by this diff. If you find nothing, return {"findings": []}. Returning nothing is a good outcome, not a failure.
