# ADR-001: Contract Ownership and Versioning

Status: Accepted

## Context

API DTOs and cross-module types currently appear in application clients,
`packages/schema` and feature packages. TypeScript alone cannot detect wire
compatibility regressions or establish a single owner.

## Decision

`packages/contracts` owns versioned cross-boundary DTOs and runtime schemas.
Every public contract has an owner, purpose, consumers, boundary class and
strict compatibility fixture. Wire contracts carry an explicit version.
Breaking changes create a parallel version; they never mutate an established
fixture in place.

## Alternatives

- Let each app own DTOs: rejected because definitions drift.
- Export ORM/domain types directly: rejected because persistence and secrets
  become accidental API surface.
- Rely on compile-time types only: rejected because deployed consumers and JSON
  payloads are outside the compiler graph.

## Consequences

Mapping at API boundaries is deliberate overhead. Compatibility becomes
reviewable and testable. Existing DTOs require incremental migration rather
than a flag-day rewrite.

## Migration / Enforcement

Use `docs/contracts/CONTRACT_BOUNDARIES.md`, the machine-readable catalog and
strict fixtures. Contract changes require Contracts maintainer review and named
consumer tests. Deprecation must identify replacement and removal criteria.
