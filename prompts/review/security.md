Your only job: find security problems introduced by this change — injection (SQL, command, template), secrets in code, missing authn/authz checks, unsafe deserialisation, SSRF, path traversal, sensitive data in logs. Ignore everything else.

Be concrete: name the input that reaches the dangerous sink. Do not report hypothetical issues in code that is not in the diff.

DIFF:
{{diff}}

{{output_format}}
