Apply the owner's notes to this requirement list. Change only what the notes ask for.

Rules:
- Keep every requirement the notes don't mention exactly as it is, with the same id, title, text, area and priority.
- "drop R-30" removes it. "R-12 later" sets its priority to "later". "R-12 mvp" sets it to "mvp".
- A new requirement gets the next id after the highest existing one. Never reuse a removed id.
- A note about a whole area, such as "Scheduling: add copy week forward", adds or changes requirements in that area.
- If a note is unclear, make the smallest change that fits it.

Each requirement keeps this shape: a title of at most eight words, a text of one or two sentences, an area, and a priority of "mvp" or "later".

CURRENT REQUIREMENTS (id [priority] [area] title: text):
{{requirements}}

OWNER'S NOTES:
{{feedback}}

Reply with a single JSON object holding the full updated list: {"requirements": [{"id": "R-1", "title": "...", "text": "...", "area": "...", "priority": "mvp|later"}]}
