# Route handlers

- A route handler parses and validates the request, calls one service function and shapes the response. It holds no business logic and no SQL.
- Invalid input returns 400 with `{ "error": "<what was wrong>" }`.
- Route handlers never catch an error just to hide it. Unexpected errors reach the framework's error handler.
