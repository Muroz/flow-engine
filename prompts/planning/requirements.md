Turn this brief into numbered, testable requirements. Each requirement states an observable behaviour, not an implementation. Where the brief leaves something open, choose a reasonable default and say so in the requirement text.

Scope:
- Mark a requirement "mvp" only if the smallest version that proves the brief's core loop needs it. Mark everything else "later", including anything the brief lists as out of scope.
- Aim for 15 to 30 MVP requirements. Merge requirements that a reviewer would check together.

Shape:
- title: at most eight words, readable on its own, such as "Drag to create a shift".
- text: one or two sentences.
- area: one of five to eight feature areas you choose for this project, such as "Accounts", "Scheduling" or "Reports". Use the same spelling every time.

BRIEF:
{{brief}}

Reply with a single JSON object: {"requirements": [{"id": "R-1", "title": "...", "text": "...", "area": "...", "priority": "mvp|later"}]}
