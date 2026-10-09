Your only job: check whether this change satisfies the task's acceptance criteria. Ignore style, security and architecture — other reviewers cover those.

TASK: {{task_title}}

ACCEPTANCE CRITERIA:
{{acceptance_criteria}}

DECISIONS THE CRITERIA NAME:
{{decisions}}

Where a criterion points to an ADR, such as "as ADR-0006 scopes it", judge it as that ADR scopes it, including any limit the ADR puts on how severe a finding can be.

For each criterion that is missing, only partly met, or contradicted by the diff, report one finding. Do not report criteria that are met.

PROJECT STANDARDS:
{{standards}}

DIFF:
{{diff}}

{{output_format}}
