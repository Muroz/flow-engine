# ADR-0001: All database access goes through the repository layer

## Status
Accepted

## Relations
None.

## Context
Queries were scattered across route handlers, which made them hard to test and easy to get wrong.

## Decision
All database access goes through functions in src/db/repository.ts. Route handlers and services never import `pg` or create a Pool. Every query is parameterised.

## Consequences
Adding a query means adding a repository function first. Tests can stub the repository.
