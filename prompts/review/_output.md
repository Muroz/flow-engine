Reply with a single JSON object and nothing else:

{"findings": [{"title": "short imperative summary", "file": "path/in/diff.ts", "line": 42, "severity": "nit|minor|major|blocker", "rationale": "why this is a problem, one or two sentences", "suggestion": "concrete fix (optional)"}]}

Severity guide:
- blocker: must not merge. A security hole in code that runs, data loss, or a broken build or failing check.
- major: a bug in code that runs, a missed acceptance criterion, or a broken ADR or project standard.
- minor: worth fixing but not blocking. Hardening beyond what the task asks, unusual ways around a rule, unclear docs.
- nit: taste.
If neither the task nor an ADR nor a project standard asks for it, it is minor at most.
Docs and comments are minor at most.
Don't ask this change to build something an ADR or standard describes but the task doesn't ask for, such as a helper a later task adds. Judge only whether the change contradicts the decision.
Only report problems introduced or touched by this diff. If you find nothing, return {"findings": []}. Returning nothing is a good outcome, not a failure.
