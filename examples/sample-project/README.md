# Sample project

A tiny order API that the sample flows run against. It isn't a working app. It holds enough for every node to have something to read.

| File | Used by |
|---|---|
| `.flows.yaml` | Every flow. Models, reviewers, thresholds, checks and conventions. |
| `brief.md` | `pnpm plan:sample`. A returns portal brief with gaps on purpose, so the discovery loop runs. |
| `docs/prd.md` | No flow reads it yet. `loadPrd` in `packages/core` is ready for the first one that does. |
| `docs/adr/0001-repository-layer.md` | The architecture reviewer. All database access goes through `src/db/repository.ts`. |
| `docs/standards/routes.md` | The architecture and correctness reviewers, and the coding agent, through `standards` in `.flows.yaml`. How route handlers validate input and handle errors. |
| `plan/tasks.yaml` | `flows tasks`, `review --task` and `deliver`. Three tasks, T-001 to T-003. |
| `changes/T-002.diff` | `pnpm review:sample` and `pnpm deliver:sample`. An attempt at T-002 with problems on purpose. |
| `src/` | The code the diff applies to. |

`changes/T-002.diff` includes a hard-coded secret, SQL built by string interpolation, no tests, a route that skips the repository layer and a swallowed error. The offline review finds all of them and exits with code 2. Offline delivery replays the same diff three times, hits the stop rule and escalates.

The sample project lives inside the engine repo and isn't a git repository of its own. The `claude-code` agent refuses to run on it. To try the agent, use a real repo.
