# ADR-0001: All database access goes through the repository layer

Date: 2026-10-09

## Status
Accepted

## Relations
None.

## Context
Queries were scattered across route handlers, which made them hard to test and easy to get wrong.

## Decision
1. All database access goes through functions in src/db/repository.ts.
2. Route handlers and services never import `pg` or create a Pool.
3. Every query is parameterised.

## Consequences
Adding a query means adding a repository function first. Tests can stub the repository.
