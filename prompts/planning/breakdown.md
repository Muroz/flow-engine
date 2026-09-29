Break this project into tasks a coding agent can complete and a reviewer can check in one sitting (roughly half a day each).

Rules:
- Every task lists the requirement ids it serves and the ADRs it must respect.
- dependsOn lists task ids that must be merged first. Keep the graph shallow so work can run in parallel.
- Acceptance criteria are observable and checkable from a diff plus tests.
- risk is high for anything touching auth, payments, data migrations or public APIs.

REQUIREMENTS:
{{requirements}}

DECISIONS:
{{adrs}}

PREVIOUS BREAKDOWN:
{{previous}}

{{gaps}}

Reply with a single JSON object: {"tasks": [{"id": "T-001", "title": "...", "requirementIds": ["R-1"], "adrRefs": ["ADR-0001"], "dependsOn": [], "acceptanceCriteria": ["..."], "risk": "low|medium|high", "estimate": "S|M|L"}]}
