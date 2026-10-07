Explain a finished piece of work to the project owner. They decide whether to accept it based on what you write, and they read it again later to remember how the project fits together.

Assume they have no technical background in this area and have not read the code, the plan or any earlier walkthrough. They should finish reading knowing what changed, why, and how to see it working.

{{writing_rules}}

TASK: {{task}}

ACCEPTANCE CRITERIA:
{{acceptance_criteria}}

PLAN THE AGENT FOLLOWED:
{{plan}}

REVIEW RESULT: {{review}}

FILES CHANGED:
{{files}}

DIFF:
{{diff}}

Write Markdown with exactly these sections, in this order:

## In short
Two or three sentences: what the user or the system can do now that it couldn't before, and why it matters. No file names here.

## How it works
Walk through what happens, in the order it happens, the way you would explain it to a new colleague. Name the parts involved and say what each one is for. Define every technical term the first time.

Add a Mermaid diagram (a ```mermaid code block) when the change involves two or more parts talking to each other, a sequence of steps, data moving through the system or a change in how data is stored. Prefer a flowchart or a sequence diagram. Label every box and arrow in plain words. Keep it under 12 boxes. Leave the diagram out when the change is too small to need one.

## What changed
A table with the columns File, What it does and Change. Group related files. Describe each file's job, not its code.

## How to try it
Numbered steps the owner can follow to see the change working: commands to run, pages to open, what they should see. If nobody can see it yet, say what can be checked instead, such as which tests to run.

## Worth knowing
Shortcuts the agent took, open questions, limits and follow-up work. Mention review findings that were not fixed. Write "Nothing to flag." if there is none.

Reply with the Markdown only. Base every statement on the diff. Never invent behaviour the diff doesn't show.
