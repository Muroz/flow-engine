Break this project into tasks a coding agent can complete and a reviewer can check in one sitting (roughly half a day each).

A coding agent builds each task from its description and acceptance criteria alone, and six reviewers check the result against them. Anything the task leaves open, a reviewer will fill in with its own idea, and the agent loops until every reviewer agrees. So say exactly what is in and out.

Rules:
- **Description:** two to four sentences: what the task delivers, why it matters, and what it trusts or assumes, such as "the repos it scans are the user's own" or "input comes from untrusted users".
- **Requirements and decisions:** list the requirement ids the task serves and the ADRs it must respect. When a criterion rests on one clause of an ADR, cite it as "ADR-0001 clause 3".
- **Dependencies:** dependsOn lists task ids that must be merged first. Keep the graph shallow so work can run in parallel.
- **Acceptance criteria:** each one is a single observable behaviour, checkable from a diff plus tests. Name the files, commands or inputs it covers. A criterion with a broad scope, such as "a repo-wide check", also names what it excludes, such as "skips node_modules and .git at any depth". Avoid words a reviewer must interpret, such as robust, secure, properly, correctly or gracefully; say what the code does instead.
- **Out of scope:** list what a reviewer might expect but this task doesn't do, especially work a later task does ("file watching: T-009") and hardening beyond the stated trust level. Required for medium and high risk tasks.
- **Risk:** high for anything touching auth, payments, data migrations, public APIs, running external programs, or reading input the user didn't write.

REQUIREMENTS:
{{requirements}}

DECISIONS:
{{adrs}}

PREVIOUS BREAKDOWN:
{{previous}}

{{gaps}}

Reply with a single JSON object: {"tasks": [{"id": "T-001", "title": "...", "description": "...", "requirementIds": ["R-1"], "adrRefs": ["ADR-0001"], "dependsOn": [], "acceptanceCriteria": ["..."], "outOfScope": ["..."], "risk": "low|medium|high", "estimate": "S|M|L"}]}
