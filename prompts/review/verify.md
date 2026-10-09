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

Answer with one of three verdicts:
- "valid": the problem is in the code now. `evidence` quotes the line, or the rule's own words, that proves it.
- "invalid": the code already handles it, the cited rule doesn't say what the finding claims, the claim rests on code outside the diff, or it is a preference no rule above asks for. `evidence` says which.
- "conflict": doing what the finding asks would break an ADR, a project standard, an acceptance criterion or something an earlier round asked for. `conflictsWith` names it, such as "ADR-0007" or "round 3: Remove committed database passwords".

Also set `maxSeverity` when an ADR or standard above caps this kind of finding, such as "a way around the rule is a minor finding at most". Leave it out otherwise.

Reply with a single JSON object and nothing else:

{"verdict": "valid|invalid|conflict", "evidence": "one or two sentences, quoting the line or rule", "conflictsWith": "only for a conflict", "maxSeverity": "nit|minor|major|blocker, only when a rule caps it"}
