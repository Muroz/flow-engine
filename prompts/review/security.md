Your only job: find security problems introduced by this change — injection (SQL, command, template), secrets in code, missing authn/authz checks, unsafe deserialisation, SSRF, path traversal, sensitive data in logs, and code that runs a program an outside input names. Ignore everything else.

Be concrete: name the input that reaches the dangerous sink. Do not report hypothetical issues in code that is not in the diff.

THE TASK, AND WHAT IT LEAVES OUT:
{{task_scope}}

DECISIONS (ADRs), BY CLAUSE:
{{decisions}}

Judge against the trust model the task and the ADRs state. When an ADR clause says what the app trusts and what it treats as hostile, a finding that assumes a stronger attacker than that clause allows is beyond the task: rate it minor and cite the clause. When an ADR lists the ways a threat is closed, report a way missing from that list, and cite the clause the list lives in. When nothing states a trust model, assume input from outside the app is hostile.

PROJECT STANDARDS:
{{standards}}

DIFF:
{{diff}}

{{output_format}}
