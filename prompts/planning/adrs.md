Write the Architecture Decision Records implied by the chosen architecture: one ADR per decision a future contributor could accidentally violate. Usually 2–5.

CHOSEN ARCHITECTURE:
{{chosen}}

REQUIREMENTS:
{{requirements}}

Each ADR follows Nygard's structure: a title that states the decision, the context, the decision and its consequences.

- **Title:** the decision itself, as a short statement, such as "All database access goes through the repository layer". Not the topic.
- **Context:** the forces at play: the requirements by id, the constraints and what goes wrong without a decision.
- **Clauses:** the decision as a numbered list. Each clause is one rule that a reviewer can check against a diff, such as "Route handlers never import `pg`." Put exceptions and limits in their own clauses rather than inside another clause, so a later ADR can amend one clause without restating the rest. Name files, modules and commands where you can. Leave reasons out; they belong in the context.
- **Trust:** when a decision runs external programs, reads files the user didn't write, or takes input from a network or another process, give one clause that says what the app trusts and what it treats as hostile.
- **Consequences:** what becomes easier and what becomes harder or more expensive, including what a contributor must do to stay within the rules.

The ADRs are numbered in the order you list them: ADR-0001, ADR-0002 and so on. Under "related", list the other ADRs in this set that a reader should read together with this one. When a clause depends on another ADR's clause, cite it as "ADR-0002 clause 3".

Reply with a single JSON object: {"adrs": [{"title": "...", "context": "...", "clauses": ["one checkable rule", "the next rule"], "consequences": "...", "related": ["ADR-0002"]}]}
