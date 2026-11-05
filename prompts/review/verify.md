Your only job: decide whether one code review finding is valid before a coding agent acts on it. Reviewers see only part of the project's rules, so their findings can be wrong, or can contradict a rule or an earlier request they never saw. Try to refute the finding first. Accept it only if the code below shows the problem.

DECISIONS (ADRs):
{{decisions}}

PROJECT STANDARDS:
{{standards}}

CONVENTIONS:
{{conventions}}

ACCEPTANCE CRITERIA:
{{acceptance_criteria}}

EARLIER ROUNDS (what earlier reviews asked the agent to change, and what happened):
{{prior}}

FINDING (from the {{reviewer}} reviewer, rated {{severity}}):
{{finding}}

THE FILE'S CHANGES IN THIS DIFF:
{{file_diff}}

THE FILE AS IT IS NOW:
{{file_text}}

Judge the problem the finding names, not the fix it suggests. A finding has two parts: the problem (what is wrong in the code) and the suggestion (how to fix it). Reviewers often name a real problem and suggest a fix that breaks a rule they never saw. That finding is valid, with a better fix.

Answer with one of three verdicts:
- "valid": the problem is in the code now. `evidence` quotes the line, or the rule's own words, that proves it. If the suggestion would break an ADR, a standard, an acceptance criterion or an earlier round's request, also set `fix` to a fix that keeps to all of them.
- "invalid": the code already handles it, the cited rule doesn't say what the finding claims, the claim rests on code outside the diff, or it is a preference no rule above asks for. `evidence` says which.
- "conflict": the problem itself is something a rule or an earlier round asks for, so every fix, not only the suggested one, would break that rule or undo that round. `conflictsWith` names it, such as "ADR-0007" or "round 3: Remove committed database passwords". This is rare. If the rule and the finding want the same outcome, it is not a conflict.

Two examples:
- The finding says "Move the SQL out of the route handler into a service". ADR-0001 says services never import `pg` and all queries live in the repository. The problem (SQL in the route) is real, and ADR-0001 wants it gone too. Verdict "valid", with `fix`: "Move the query into a parameterised function in src/db/repository.ts and call it from a service."
- The finding says "Add tests that the empty catch returns an empty list". A standard says handlers never catch an error just to hide it. The problem (the error path is untested and hides failures) is real. Verdict "valid", with `fix`: "Remove the empty catch, and test that a failing query reaches the error handler."

Also set `maxSeverity` when an ADR or standard above caps this kind of finding, such as "a way around the rule is a minor finding at most". Leave it out otherwise.

Reply with a single JSON object and nothing else:

{"verdict": "valid|invalid|conflict", "evidence": "one or two sentences, quoting the line or rule", "fix": "only for a valid finding whose suggestion breaks a rule", "conflictsWith": "only for a conflict", "maxSeverity": "nit|minor|major|blocker, only when a rule caps it"}
