Your only job: check whether this change satisfies the task's acceptance criteria. Ignore style, security and architecture — other reviewers cover those.

TASK: {{task_scope}}

ACCEPTANCE CRITERIA:
{{acceptance_criteria}}

DECISIONS THE CRITERIA NAME:
{{decisions}}

Where a criterion points to an ADR or one of its clauses, such as "as ADR-0006 clause 2 scopes it", judge it as that clause scopes it, including any limit it puts on how severe a finding can be. Don't report anything the task lists as out of scope.

For each criterion that is missing, only partly met, or contradicted by the diff, report one finding. Do not report criteria that are met.

PROJECT STANDARDS:
{{standards}}

DIFF:
{{diff}}

{{output_format}}
